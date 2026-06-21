# Tandem — Tauri Conversation App Design

**Date:** 2026-06-17
**Status:** Approved design, pending spec review
**Project:** `tandem` (standalone — lives at `C:\LOCAL FILES\Claude Code\Tauri\tandem`, separate from the Converse .NET API repo)

## Purpose & context

Tandem is a **Windows desktop app** (Tauri v2) for **practising spoken German**.
You press record, speak German, and hear a German reply from an LLM "tutor" —
the core conversation loop of the Converse project. It is the spoken counterpart
to the `vorleser` read-aloud extension.

It is a thin client over the existing Converse .NET API:
- `POST /conversations` — start a session (with a German system prompt + voice).
- `POST /conversations/{id}/turn` — send recorded audio, get back the tutor's
  spoken German reply (WAV) plus `X-User-Transcript` and `X-Assistant-Text`
  headers (your German and the tutor's German, as text).

The API runs locally (default `http://127.0.0.1:5000`) and requires LM Studio
running with a German-capable model for the LLM step.

## Scope

**v1 includes:**
- A **record** button (click to start, click to stop) that sends a turn and
  plays the spoken reply.
- A **chat-style transcript** of the session (your German + the tutor's German),
  built from the turn response headers.
- A **New conversation** action (starts a fresh session, clears the transcript).
- A **settings** overlay: server URL, tutor **voice** (from `/voices`), and the
  **system prompt**; plus a **Test connection** button. Settings persist locally.
- A header **status** indicator from `/health`.

**Out of scope for v1** (possible later):
- Push-to-talk / voice-activity detection (v1 is click-to-toggle).
- Per-message replay buttons; persisting past conversations to disk.
- Non-localhost / remote servers (v1 assumes a local server).
- Installer/packaging polish (v1 runs via `tauri dev`/a local build).

## Approach

Mic capture happens in the **web frontend** (`getUserMedia` + Web Audio →
16-bit PCM WAV); all API calls go through the **Tauri HTTP plugin**
(`@tauri-apps/plugin-http`), which routes requests through Rust. This is chosen
over a plain browser `fetch` for two reasons: it avoids WebView CORS/CSP issues,
and — importantly — it can **read the custom `X-User-Transcript` /
`X-Assistant-Text` response headers**, which a browser `fetch` could not without
the server adding `Access-Control-Expose-Headers`.

**Risk / fallback:** mic access via WebView2 `getUserMedia` needs the app to
grant the webview's media-permission request. If that proves unreliable, the
fallback is native capture in Rust via the `cpal` crate (more code, but robust).
v1 targets the web-capture path.

## Architecture

A Tauri v2 app: a minimal Rust shell hosting a WebView2 window. The **vanilla
HTML/CSS/JS** frontend owns the UI, mic capture, and API calls. Rust stays
minimal — window setup, registering the HTTP plugin, and granting the webview
mic permission. All app state (session id, transcript, settings) lives in the
frontend; settings persist in `localStorage`.

## Main window (layout)

```
┌───────────────────────────────────────┐
│ Tandem · 🟢 ready          [New] [⚙]   │  header: /health status, New conversation, settings
├───────────────────────────────────────┤
│  you:   Guten Tag, wie geht es dir?    │  transcript (scrolls), from
│  tutor: Mir geht es gut, danke! …      │  X-User-Transcript / X-Assistant-Text
│  …                                      │
├───────────────────────────────────────┤
│   status line (e.g. "thinking…")        │
│              [ 🎤 Record ]              │  mic toggle → [ ■ Stop ] while recording
└───────────────────────────────────────┘
```

Settings overlay: server URL, voice dropdown (from `/voices`), system-prompt
textarea, **Test connection**, **Save**.

## Components (files)

- **`src-tauri/`** (Rust, minimal):
  - `tauri.conf.json` — window config, CSP, and the HTTP-plugin scope/allowlist
    for `http://127.0.0.1:5000/*` and `http://localhost:5000/*`.
  - `Cargo.toml` — Tauri + `tauri-plugin-http`.
  - `src/lib.rs` / `src/main.rs` — register the HTTP plugin; grant the webview's
    mic permission request.
- **`src/`** (frontend):
  - `index.html` / `styles.css` — the layout above.
  - `api.js` — `getHealth(serverUrl)`, `getVoices(serverUrl)`,
    `createConversation(serverUrl, systemPrompt, voice)` → id,
    `postTurn(serverUrl, id, wavBlob)` → `{ userText, assistantText, audio }`
    (decodes the two headers, returns the WAV bytes). Uses the Tauri HTTP plugin.
  - `audio.js` — `startRecording()` / `stopRecording()` → 16-bit mono WAV `Blob`
    (Web Audio); `playWav(bytes)`.
  - `settings.js` — load/save `{ serverUrl, voice, systemPrompt }` in
    `localStorage`; the settings overlay (incl. populating voices, Test
    connection).
  - `app.js` — wires UI events, session lifecycle, transcript rendering, status.

## Settings & storage

`localStorage` keys:
- `serverUrl` (default `http://127.0.0.1:5000`)
- `voice` (default = API's default voice, e.g. `M1`)
- `systemPrompt` (default: `"Du bist ein freundlicher, geduldiger
  Deutschlehrer. Antworte immer auf Deutsch in kurzen, einfachen Sätzen."`)

## Data flow

1. **Startup:** load settings → `GET /health` (set status; warn if `whisper`,
   `llm`, or `tts` is not ready) → `POST /conversations { systemPrompt, voice }`
   → store the returned `id`.
2. **Turn:** click record → speak → click stop → encode WAV → status
   "thinking…" → `POST /conversations/{id}/turn` (multipart `audio`) → read
   `X-User-Transcript` + `X-Assistant-Text` → append both to the transcript →
   auto-play the reply WAV → status idle.
3. **New conversation:** `POST /conversations` again (current settings), clear
   the transcript, store the new id.
4. Changing voice / system prompt in settings applies to the **next** new
   conversation.

## API contract (endpoints used)

- **`GET /health`** → `{ "whisper": bool, "tts": bool, "llm": bool }` — header
  status; all three should be true for conversations.
- **`GET /voices`** → `{ "default": "M1", "voices": [ { "id", "gender" }, … ] }`
  — settings dropdown.
- **`POST /conversations`** — body `{ "systemPrompt": string, "voice": string }`
  → `201` `{ "id": "<guid>" }`.
- **`POST /conversations/{id}/turn`** — `multipart/form-data` with an `audio`
  WAV file → `audio/wav` body + URL-encoded headers `X-User-Transcript`,
  `X-Assistant-Text`. `404` unknown session; `503` if STT/TTS not ready.

## Backend dependencies (in the Converse .NET repo)

Two additions, implemented and unit-tested in the .NET project:

1. **`GET /voices`** — returns installed voices + default (also used by
   `vorleser`; already specified there).
2. **Per-conversation voice** — `POST /conversations` accepts an optional
   `voice`; it is stored on the conversation session and the orchestrator uses
   it for the reply TTS (the 4-arg `SynthesizeAsync(text, voice, lang, ct)`).
   Touches `CreateConversationRequest`, the session model, `IConversationStore.
   Create`, and `ConversationOrchestrator`. An unknown voice surfaces as the
   existing `400`/error path. When `voice` is omitted, the server default is
   used (unchanged behavior).

## Error handling

- **Mic permission denied / no device:** inline status ("Microphone
  unavailable — check Windows mic permissions") and the record button disabled.
- **Server unreachable / non-200 / `503`:** inline status with the message and a
  red header status dot; "Test connection" in settings validates setup.
- **LLM not ready (`llm:false`):** header warns that LM Studio isn't reachable,
  since turns will fail without it.
- **Empty/failed transcription:** if a turn returns empty user text, show it as
  such rather than silently appending nothing.

## Permissions

- WebView2 **microphone** access (granted via the Rust mic-permission handler).
- Tauri **HTTP plugin** scope limited to the local server origins
  (`127.0.0.1:5000`, `localhost:5000`). Remote origins are out of scope for v1.

## Testing

- **Backend (per-conversation voice + `/voices`):** unit-tested in the .NET
  project (xUnit).
- **Tandem app:** manual test checklist (desktop mic/audio can't be meaningfully
  auto-tested):
  1. App launches; header shows ready when the API + LM Studio are up.
  2. Settings: Test connection ✅; voice dropdown lists M1–M5/F1–F5; set a voice
     and a German system prompt; Save.
  3. Click record → speak a German sentence → stop → "thinking…" → transcript
     shows your German and the tutor's German; the reply plays in the chosen
     voice.
  4. Take another turn → the tutor's reply reflects the conversation history.
  5. New conversation → transcript clears; a fresh session starts.
  6. Stop LM Studio → a turn surfaces a clear error; header reflects `llm:false`.
  7. Deny mic permission → clear "microphone unavailable" message.

## Success criteria

On Windows, with the Converse API and LM Studio running, Tandem lets the user
hold a spoken German conversation: record → see both sides transcribed → hear
the tutor's spoken German reply in the chosen voice, across multiple turns, with
a working New conversation and settings, and graceful errors when the server,
LLM, or microphone is unavailable.
