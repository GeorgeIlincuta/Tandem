# Tandem (streaming, single-process Rust) — Design

**Date:** 2026-07-20
**Status:** Design — awaiting review before implementation plan
**Supersedes for new work:** the `tandem` (Tauri client) + `Converse` (.NET API) two-process split

## Goal

Make spoken-German practice feel **as close to a real conversation as possible** by
minimizing perceived latency. Fold the STT + TTS + orchestration that currently live in
the .NET `Converse` service directly into the Tauri app's Rust backend, and make the whole
turn a **streaming pipeline** so audio starts playing while the reply is still being
generated. The LLM stays in **LM Studio** (kept as a local sidecar — it already streams and
is GPU-tuned; embedding llama.cpp ourselves would not be faster).

Net result: **one process** (Tauri + Rust), **no .NET runtime**, **no localhost HTTP hop**
for STT/TTS, and an overlapped LLM→TTS→playback loop.

### Non-goals (this spec)

- Fully self-contained app with an embedded LLM. LM Studio remains a dependency. (Could be
  revisited later behind the same `LlmClient` interface.)
- Voice-activity detection / hands-free turn-taking. **Push-to-talk is kept** (the existing
  record-bar UX). VAD is a possible follow-up.
- Multi-user / persisted conversations. State stays in memory, single active conversation.

## Why single-process actually helps latency

The localhost HTTP hop between the current Tauri client and .NET is ~1 ms — not the
bottleneck. The bottleneck is that the current `Converse` `POST /turn` is **turn-batched**:
record → whole STT → whole LLM reply → whole TTS → one complete WAV → *then* play. Perceived
latency is the **sum of every stage**.

Streaming changes that to:

```
mic ─▶ Whisper STT ─▶ LM Studio (SSE token stream) ─▶ sentence chunker ─▶ Supertonic TTS ─▶ audio queue
                                                        │                                     │
                                                        └── sentence 2 synthesizing ──────────┘ while sentence 1 plays
```

Perceived latency drops from *"sum of everything"* to roughly *"STT + first sentence of the
reply + one sentence of TTS."* A single Rust process is the cleanest substrate for this: the
LLM token stream, the sentence chunker, and the TTS/playback queue communicate over in-memory
channels — no HTTP boundaries, no temp WAV files. (The existing .NET `/turn` is
architecturally whole-WAV; getting streaming out of it would require re-architecting it
anyway.)

## Architecture

New Tauri v2 app in a **separate folder** (proposed `C:\LOCAL FILES\Claude Code\Tauri\tandem-live` —
name to confirm). The existing `tandem` .NET-backed app is left intact as a reference/fallback.

The **frontend is reused** from `tandem` (high-fidelity UI, frameless transparent window,
custom titlebar, bundled fonts). Only the plumbing behind it changes: from `window.__TAURI__.http.fetch`
calls to the .NET API → `invoke(...)` into Rust commands plus Tauri **event** listeners for the
stream.

### Rust backend modules (`src-tauri/src/`)

| Module | Responsibility | Key crates |
|--------|----------------|------------|
| `stt/` | Whisper transcription of a recorded utterance → text | `whisper-rs` (whisper.cpp bindings) |
| `llm/` | LM Studio OpenAI-compatible `/v1/chat/completions` with `stream:true`; yields tokens; holds the `ChatMessage` type | `reqwest` (SSE), `serde` |
| `tts/` | Supertonic ONNX pipeline (text encoder → duration → vector estimator → vocoder) + voice-style loader + text processor/unicode indexer | `ort` (ONNX Runtime), based on Supertonic's official `rust/` example |
| `pipeline/` | The orchestrator: STT → stream LLM → **sentence chunker** → TTS task → **audio player**; emits lifecycle events | `tokio` (channels/tasks), `rodio` (gapless playback queue) |
| `state.rs` | App state: conversation history (`Vec<ChatMessage>`), loaded model handles, current voice/config | — |
| `config.rs` | Strongly-typed settings (whisper model path, supertonic dirs, default voice, language, cfm steps, speed, GPU on/off, LM Studio base URL + model) — mirrors `Converse`'s `appsettings.json` | `serde` |
| `commands.rs` | `invoke` handlers (see below) | `tauri` |

### Tauri commands (frontend → Rust)

- `health() -> { whisper: bool, tts: bool, llm: bool }` — models loaded + LM Studio reachable.
- `list_voices() -> { voices: string[], default: string }` — scans the voices dir (flat
  string array, gender inferred from `F`/`M` prefix, same contract the current UI expects).
- `new_conversation({ systemPrompt, voice })` — resets in-memory history, sets voice.
- `submit_turn({ audio: bytes })` — **fire-and-forget**; kicks off the streaming pipeline as a
  background task. Progress/results come back as events, not a return value.

### Tauri events (Rust → frontend) for one turn

Emitted over the turn's lifecycle so the UI updates live:

- `turn:transcript` `{ text }` — the user's transcribed utterance (fills the "Du" turn).
- `turn:sentence` `{ text }` — each assistant sentence as it's produced (appended to the
  tutor turn so text appears progressively).
- `turn:speaking` — first audio chunk has started playing (UI → "speaking" state).
- `turn:done` — reply fully generated and queued/played (UI → "ready").
- `turn:error` `{ message }` — any stage failed (UI shows the message, resets to "ready").

## Data flow (one turn, detailed)

1. **Capture (frontend):** push-to-talk. `startRecording()` / `stopRecording()` keep using
   `MediaRecorder` in the WebView (unchanged from current `audio.js`), producing a WAV/PCM
   blob. On stop, the bytes are handed to Rust via `invoke('submit_turn', { audio })`.
2. **STT (Rust):** decode to PCM (`hound`/`symphonia` as needed), run Whisper → user text.
   Emit `turn:transcript`. Append `{ role: "user", content }` to history.
3. **LLM stream (Rust):** POST the full history to LM Studio with `stream: true`; read the SSE
   delta stream. Tokens flow into the sentence chunker as they arrive.
4. **Sentence chunker (Rust):** accumulate tokens; flush a chunk on a sentence boundary
   (`.`/`!`/`?`, with abbreviation guards and a min-length so tiny fragments don't get their
   own TTS call). Each completed sentence is (a) emitted as `turn:sentence` and (b) pushed onto
   the TTS channel. On stream end, flush the trailing partial sentence.
5. **TTS task (Rust):** a separate task/thread consumes sentences from the channel, synthesizes
   each with Supertonic (GPU via ORT execution provider, CPU fallback), and pushes the PCM to
   the audio player. Runs **concurrently** with step 3/4 — sentence _n+1_ synthesizes while
   sentence _n_ plays.
6. **Audio player (Rust):** a `rodio` `Sink` queue. The first sentence starts playing as soon as
   it's ready (emit `turn:speaking`); later sentences enqueue gaplessly behind it.
7. **Finish:** when the LLM stream ends and the TTS/playback queue drains, append the full
   assistant text to history and emit `turn:done`.

## Frontend changes (reuse + adapt `tandem/src/`)

Copy `index.html`, `styles.css`, `assets/fonts/`, `settings.js` **as-is**. Rewrite the thin
glue:

- **`api.js`** → replace the four `fetch`-to-`:5000` functions with `invoke(...)` wrappers
  (`health`, `list_voices`, `new_conversation`, `submit_turn`) and a small helper to register
  the `turn:*` event listeners.
- **`audio.js`** → keep mic capture (`startRecording`/`stopRecording`). **Remove** client-side
  `playWav` — playback now happens Rust-side (gapless streaming). The WebView no longer receives
  audio bytes.
- **`app.js`** → `onRecordClick` no longer `await`s a single `postTurn` result. Instead it calls
  `submit_turn` and lets the `turn:*` events drive the UI:
  - `turn:transcript` → fill the "Du" turn.
  - `turn:sentence` → append text to the pending tutor turn (progressive reveal).
  - `turn:speaking` → new **"speaking"** record-bar state (extends the current
    ready/recording/thinking set; caption e.g. "speaking…").
  - `turn:done` → back to "ready".
  - `turn:error` → show message, reset.

The record-bar keyframe states (`tdm-ring`/`tdm-wave`/`tdm-dot`) and the custom titlebar wiring
carry over unchanged; we add one "speaking" visual state.

## Models, config & GPU

- **Reuse the existing model files** (Whisper ggml, Supertonic ONNX + voice JSONs). For dev,
  `config.rs` points at the current `Converse/models/` dir; for a real install they live under
  the app's data dir (models are gitignored, same as `Converse`).
- **GPU (to confirm):** Supertonic via ORT — DirectML execution provider on Windows (matches
  `Converse`'s current choice), CPU fallback. Whisper via `whisper-rs` — CUDA or Vulkan build
  feature (the target machine is an RTX 5070). Default to whichever builds cleanliest with CPU
  fallback; expose `UseGpu` in config. **This is the second open decision.**
- Startup **warm-up** (port `Converse`'s idea): one throwaway TTS synthesis so the first real
  turn doesn't pay model/GPU init cost.

## Error handling

- **LM Studio down / unreachable** → `health()` reports `llm:false`; `submit_turn` emits
  `turn:error` "LLM offline"; UI status dot goes bad (existing behavior).
- **Model files missing** → the affected service reports not-ready via `health()`; record
  button stays disabled with a clear caption (mirrors `Converse`'s 503 semantics).
- **STT/TTS failure mid-turn** → `turn:error`, drain/stop the audio queue, reset to "ready".
- **Mic permission denied** → handled in the WebView as today ("Microphone unavailable").
- **Partial reply then LLM drops** → whatever sentences already synthesized still play;
  `turn:error` notes the truncation.

## Testing

- **Rust unit tests:** the sentence chunker is the highest-value target (boundary detection,
  abbreviation guards, min-length, trailing-flush); plus conversation-history management, voice
  loader, and config parsing.
- **Integration tests (gated on model presence, like `Converse`):** STT a known WAV → expected
  text; TTS a phrase → non-empty audio; and a **full-pipeline test against a mock LM Studio SSE
  server** (`wiremock`) that streams a canned multi-sentence reply, asserting the chunker emits
  the right sentences in order and the TTS/audio stages are driven correctly — no real LLM
  needed.
- **Manual / live (the real acceptance test):** run `cargo tauri dev` with LM Studio up, do the
  record→reply loop, and judge latency + German quality directly. Latency target: **audio starts
  within ~1–1.5 s of releasing the record button** on GPU (vs. sum-of-stages today).

## Proposed build phases

Detailed task breakdown comes from the writing-plans step; high-level order:

1. **Scaffold** the new Tauri app in the new folder; port the frontend shell (window/titlebar,
   fonts, styles) so it launches empty.
2. **TTS in Rust** — get Supertonic synthesizing + `rodio` playback + `list_voices`, driven by a
   temporary "type text → hear it" test command. (Proves the hardest native piece early.)
3. **STT in Rust** — Whisper transcription of a recorded blob; wire `submit_turn` → transcript.
4. **LLM streaming + chunker + full pipeline** — LM Studio SSE, sentence chunker, TTS task,
   overlapped playback, all the `turn:*` events.
5. **Frontend rewire** — `api.js`/`audio.js`/`app.js` onto commands+events; add "speaking"
   state; progressive text.
6. **Polish** — warm-up, health/error states, GPU config, settings UI parity.

## Open decisions to confirm

1. **New folder name** — default `tandem-live` (sibling of `tandem`). Override if you prefer.
2. **GPU backend for Whisper** — CUDA vs. Vulkan build feature (Supertonic uses ORT DirectML
   regardless). Default: whichever builds cleanest, CPU fallback always on.
