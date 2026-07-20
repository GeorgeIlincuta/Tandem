# TandemLive Streaming Voice App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-process Tauri v2 desktop app for low-latency spoken-German practice, where the reply is spoken as it streams (LLM tokens → sentence chunker → Supertonic TTS → overlapped playback), with STT + TTS + orchestration all in the Rust backend and LM Studio kept as the LLM sidecar.

**Architecture:** The WebView captures mic audio (push-to-talk, `MediaRecorder`) and hands the bytes to Rust via `invoke('submit_turn')`. Rust runs Whisper STT, streams a reply from LM Studio over SSE, buffers tokens into whole sentences, synthesizes each sentence with Supertonic (ONNX Runtime), and plays them gaplessly through a `rodio` queue — sentence _n+1_ synthesizing while sentence _n_ plays. Progress flows back to the WebView as `turn:*` Tauri events. No .NET, no localhost HTTP for STT/TTS.

**Tech Stack:** Tauri v2 (`--manager cargo`, `withGlobalTauri`), Rust (tokio, reqwest, serde), `whisper-rs` (STT), `ort` / ONNX Runtime (Supertonic TTS), `rodio` (playback), `hound` (WAV decode); reused vanilla-JS frontend from `tandem`. Design spec: `docs/superpowers/specs/2026-07-20-tandem-streaming-rust-design.md`.

## Global Constraints

- **App location:** `C:\LOCAL FILES\Claude Code\Tauri\TandemLive` (new folder; the existing `tandem` app is left untouched as reference/fallback).
- **LLM:** LM Studio only, via its OpenAI-compatible `POST /v1/chat/completions` with `stream: true`. Base URL default `http://127.0.0.1:1234`, model id passthrough `"local-model"`.
- **Turn-taking:** push-to-talk only. No VAD in this plan.
- **Voices contract:** `list_voices` returns a **flat string array** `{ voices: string[], default: string }` (e.g. `{"voices":["F1",...,"M5"],"default":"M1"}`); gender inferred from the `F`/`M` prefix. Match this shape exactly — the reused settings UI depends on it.
- **Language:** German (`de`) is the default for STT and TTS; configurable.
- **Audio playback happens in Rust** (gapless streaming). The WebView captures mic input but never receives reply audio bytes.
- **Models are gitignored**, reused from the existing `Converse/models/` dir in dev; path is configurable. Missing models → the component reports not-ready via `health()`.
- **Commits:** frequent, one per completed task step-group. Co-author trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **This plan builds in phases; each phase leaves the app runnable.** Phases 0–1 give a "type text → hear German" app; Phase 2 adds STT; Phase 3 makes it a live streaming conversation; Phase 4 rewires the real UI; Phase 5 polishes.

---

## File Structure

```
TandemLive/
  src/                          frontend (copied from tandem/src, glue rewritten)
    index.html                  copied as-is
    styles.css                  copied as-is (+ one "speaking" state rule)
    assets/fonts/…              copied as-is
    settings.js                 copied as-is
    api.js                      REWRITTEN: invoke wrappers + turn:* event listeners
    audio.js                    REWRITTEN: keep capture, drop playWav
    app.js                      REWRITTEN: event-driven lifecycle + "speaking" state
  src-tauri/
    Cargo.toml
    tauri.conf.json             frameless + transparent window, withGlobalTauri
    capabilities/default.json   core:window + core:event perms
    src/
      main.rs                   entry → lib run()
      lib.rs                    Tauri builder, state, command + event registration
      config.rs                 Settings struct + load
      state.rs                  AppState: history, config, model handles
      commands.rs               invoke handlers: health, list_voices, new_conversation, submit_turn, (dev) speak_text
      llm/
        mod.rs
        message.rs              ChatMessage
        client.rs               LmStudioClient: streaming SSE
      stt/
        mod.rs                  WhisperStt wrapper
      tts/
        mod.rs                  Supertonic wrapper (adapted from official rust example)
        voices.rs               voice loader + list
      pipeline/
        mod.rs
        chunker.rs              SentenceChunker (pure logic)
        player.rs               AudioPlayer (rodio Sink queue)
        orchestrator.rs         run_turn: STT → LLM stream → chunker → TTS → player + events
  models/                       gitignored (or config points at Converse/models)
  docs/
```

---

## Phase 0 — Scaffold

### Task 1: Scaffold Tauri app and port the frontend shell

**Files:**
- Create: the whole `TandemLive/` skeleton via `create-tauri-app`
- Copy: `tandem/src/*` → `TandemLive/src/*`
- Modify: `TandemLive/src-tauri/tauri.conf.json`, `TandemLive/src-tauri/capabilities/default.json`

**Interfaces:**
- Produces: a launchable empty-shell app (frameless window, custom titlebar, Tandem UI visible; buttons inert). Later tasks add the Rust commands the UI calls.

- [ ] **Step 1: Scaffold**

Run (from `C:\LOCAL FILES\Claude Code\Tauri`):
```bash
cargo create-tauri-app TandemLive --manager cargo --template vanilla --identifier com.tandem.live -y
```
Expected: `TandemLive/` created with `src/` and `src-tauri/`.

- [ ] **Step 2: Replace scaffolded frontend with the Tandem UI**

Copy `tandem/src/index.html`, `styles.css`, `assets/`, `settings.js`, `app.js`, `audio.js`, `api.js` over the scaffold's `src/`. (The three glue files are rewritten in Phase 4; copying now keeps the shell coherent.)

- [ ] **Step 3: Configure the window (frameless + transparent)**

In `TandemLive/src-tauri/tauri.conf.json`, set the main window to match `tandem`:
```json
{
  "app": {
    "windows": [
      {
        "title": "Tandem",
        "width": 760,
        "height": 820,
        "resizable": true,
        "decorations": false,
        "transparent": true
      }
    ],
    "withGlobalTauri": true,
    "security": { "csp": null }
  }
}
```

- [ ] **Step 4: Grant window + event capabilities**

In `TandemLive/src-tauri/capabilities/default.json`, ensure permissions include:
```json
{
  "permissions": [
    "core:default",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "core:event:default"
  ]
}
```

- [ ] **Step 5: Run to verify the shell launches**

Run: `cd TandemLive && cargo tauri dev`
Expected: the 760×820 frameless Tandem window appears with the titlebar and record bar; the min/max/close buttons work; record/settings buttons do nothing yet (no backend). Console may log failed `invoke`/`fetch` — acceptable at this stage.

- [ ] **Step 6: Commit**

```bash
cd TandemLive && git init && git add -A
git commit -m "Scaffold TandemLive Tauri app with ported Tandem UI shell"
```

---

## Phase 1 — TTS in Rust (type text → hear German)

### Task 2: Settings/config module

**Files:**
- Create: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod config;`), `src-tauri/Cargo.toml` (add `serde`, `serde_json`)

**Interfaces:**
- Produces:
  ```rust
  pub struct Settings {
      pub whisper_model_path: String,
      pub supertonic_models_dir: String,
      pub supertonic_voices_dir: String,
      pub default_voice: String,     // e.g. "M1"
      pub language: String,          // e.g. "de"
      pub cfm_steps: u32,            // default 8
      pub speed: f32,                // default 1.05
      pub use_gpu: bool,             // default true
      pub lm_studio_base_url: String,// default "http://127.0.0.1:1234"
      pub lm_studio_model: String,   // default "local-model"
      pub system_prompt: String,
  }
  impl Settings { pub fn load() -> Settings }   // defaults, overridable from settings.json if present
  ```

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/config.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_are_sane() {
        let s = Settings::default();
        assert_eq!(s.default_voice, "M1");
        assert_eq!(s.language, "de");
        assert_eq!(s.cfm_steps, 8);
        assert!(s.use_gpu);
        assert_eq!(s.lm_studio_base_url, "http://127.0.0.1:1234");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test config::tests::defaults_are_sane`
Expected: FAIL — `Settings` not defined.

- [ ] **Step 3: Implement**

```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub whisper_model_path: String,
    pub supertonic_models_dir: String,
    pub supertonic_voices_dir: String,
    pub default_voice: String,
    pub language: String,
    pub cfm_steps: u32,
    pub speed: f32,
    pub use_gpu: bool,
    pub lm_studio_base_url: String,
    pub lm_studio_model: String,
    pub system_prompt: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            whisper_model_path: "../models/whisper/ggml-small.bin".into(),
            supertonic_models_dir: "../models/supertonic".into(),
            supertonic_voices_dir: "../models/supertonic/voices".into(),
            default_voice: "M1".into(),
            language: "de".into(),
            cfm_steps: 8,
            speed: 1.05,
            use_gpu: true,
            lm_studio_base_url: "http://127.0.0.1:1234".into(),
            lm_studio_model: "local-model".into(),
            system_prompt: "Du bist ein freundlicher Deutschlehrer. Antworte immer auf Deutsch. Antworte in reinem Text ohne Markdown.".into(),
        }
    }
}

impl Settings {
    pub fn load() -> Settings {
        // Override defaults from settings.json next to the exe if it exists.
        std::fs::read_to_string("settings.json")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
}
```
Add to `Cargo.toml`: `serde = { version = "1", features = ["derive"] }` and `serde_json = "1"`.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test config::tests::defaults_are_sane`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add Settings config with German defaults"
```

### Task 3: Voice loader and `list_voices`

**Files:**
- Create: `src-tauri/src/tts/voices.rs`, `src-tauri/src/tts/mod.rs`
- Modify: `src-tauri/src/lib.rs` (`mod tts;`)

**Interfaces:**
- Consumes: `Settings.supertonic_voices_dir`, `Settings.default_voice`.
- Produces:
  ```rust
  pub struct VoiceList { pub voices: Vec<String>, pub default: String }
  pub fn list_voices(voices_dir: &str, default: &str) -> VoiceList
  ```
  `voices` = the JSON file stems in `voices_dir`, sorted with `F*` before `M*` then numerically (F1..F5, M1..M5).

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/tts/voices.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn lists_and_sorts_voice_stems() {
        let dir = std::env::temp_dir().join("tl_voices_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for v in ["M2", "F1", "M1", "F10"] {
            fs::write(dir.join(format!("{v}.json")), "{}").unwrap();
        }
        let out = list_voices(dir.to_str().unwrap(), "M1");
        assert_eq!(out.voices, vec!["F1", "F10", "M1", "M2"]);
        assert_eq!(out.default, "M1");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test tts::voices::tests::lists_and_sorts_voice_stems`
Expected: FAIL — `list_voices` not defined.

- [ ] **Step 3: Implement**

```rust
use serde::Serialize;

#[derive(Serialize)]
pub struct VoiceList {
    pub voices: Vec<String>,
    pub default: String,
}

pub fn list_voices(voices_dir: &str, default: &str) -> VoiceList {
    let mut voices: Vec<String> = std::fs::read_dir(voices_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| e.path().file_stem().and_then(|s| s.to_str()).map(String::from))
        .collect();
    voices.sort_by(|a, b| gender_key(a).cmp(&gender_key(b)));
    VoiceList { voices, default: default.to_string() }
}

// Sort F before M, then by trailing number so F2 < F10.
fn gender_key(v: &str) -> (char, u32, String) {
    let prefix = v.chars().next().unwrap_or('Z');
    let num: u32 = v[1..].parse().unwrap_or(u32::MAX);
    (prefix, num, v.to_string())
}
```
In `src-tauri/src/tts/mod.rs`: `pub mod voices;`

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test tts::voices::tests::lists_and_sorts_voice_stems`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add voice loader with F-before-M numeric sort"
```

### Task 4: Supertonic TTS wrapper (adapt official Rust example)

**Files:**
- Create: `src-tauri/src/tts/mod.rs` (extend), pulling in adapted pipeline code
- Modify: `src-tauri/Cargo.toml` (add `ort`, `ndarray` per the example)

**Interfaces:**
- Consumes: `Settings` (models dir, voices dir, cfm_steps, speed, language, use_gpu).
- Produces:
  ```rust
  pub struct Supertonic { /* loaded ORT sessions + config */ }
  impl Supertonic {
      pub fn load(settings: &Settings) -> anyhow::Result<Supertonic>;
      pub fn is_ready(&self) -> bool;
      /// Synthesize one text chunk to mono f32 PCM at the model's sample rate.
      pub fn synthesize(&self, text: &str, voice: &str, lang: &str) -> anyhow::Result<(Vec<f32>, u32)>;
  }
  ```

> **This task adapts Supertonic's official `rust/` example — do NOT invent the ONNX tensor code.** Clone `https://github.com/supertone-inc/supertonic`, read `rust/`, and port its synthesis path into `Supertonic::synthesize`. The example is a CLI; your job is to (a) load the 4 ONNX sessions (`text_encoder`, `duration_predictor`, `vector_estimator`, `vocoder`) + `tts.json` + `unicode_indexer.json` once in `load()`, (b) load the voice-style JSON for `voice` from `voices_dir`, (c) run the same encode → duration → CFM (`cfm_steps`) → vocoder flow the example runs, honoring `speed`, and return the f32 PCM + sample rate. Cross-reference the existing .NET port in `Converse/Converse.Api/Tts/` (`SupertonicPipeline.cs`, `SupertonicTextProcessor.cs`, `UnicodeIndexer.cs`, `VoiceStyle.cs`) for the text-processing details (unicode indexing, `<lang>` tagging) if the Rust example is terse.

- [ ] **Step 1: Add deps and the ORT execution-provider selection**

In `Cargo.toml`, add the versions the Supertonic example pins (read its `rust/Cargo.toml`), e.g. `ort = { version = "...", features = ["directml"] }`, `ndarray = "..."`, `anyhow = "1"`. In `load()`, build the session with the DirectML EP when `settings.use_gpu`, else CPU; on EP init failure, log and fall back to CPU (do not fail `load`).

- [ ] **Step 2: Write a model-gated integration test**

In `src-tauri/tests/tts_integration.rs`:
```rust
// Skips unless the Supertonic model files are present (like Converse's gated tests).
use tandemlive_lib::{config::Settings, tts::Supertonic};

fn models_present(s: &Settings) -> bool {
    std::path::Path::new(&s.supertonic_models_dir).join("vocoder.onnx").exists()
}

#[test]
fn synthesizes_nonempty_audio_when_models_present() {
    let s = Settings::default();
    if !models_present(&s) { eprintln!("skip: no supertonic models"); return; }
    let tts = Supertonic::load(&s).expect("load");
    let (pcm, sr) = tts.synthesize("Guten Tag!", "M1", "de").expect("synth");
    assert!(sr >= 16000);
    assert!(pcm.len() > sr as usize / 10, "expected >0.1s of audio");
}
```
(Expose modules to integration tests: set `name = "tandemlive_lib"` for the lib target in `Cargo.toml` and `pub mod`-export `config`, `tts`, etc. in `lib.rs`.)

- [ ] **Step 3: Implement `load` + `synthesize` by porting the example**

Port the example's flow into the interface above. Keep `synthesize` synchronous and pure of any playback concerns (returns PCM only).

- [ ] **Step 4: Run the gated test**

Run: `cargo test --test tts_integration -- --nocapture`
Expected (models present): PASS, prints nothing about skipping. (Models absent): prints "skip", passes.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add Supertonic TTS wrapper adapted from official Rust example"
```

### Task 5: Audio player + dev `speak_text` command (hear it end-to-end)

**Files:**
- Create: `src-tauri/src/pipeline/player.rs`, `src-tauri/src/pipeline/mod.rs`
- Modify: `src-tauri/src/commands.rs` (dev `speak_text`), `src-tauri/src/lib.rs` (register), `Cargo.toml` (`rodio`)

**Interfaces:**
- Produces:
  ```rust
  pub struct AudioPlayer { /* rodio OutputStream + Sink */ }
  impl AudioPlayer {
      pub fn new() -> anyhow::Result<AudioPlayer>;
      /// Enqueue mono f32 PCM; returns immediately, plays gaplessly behind prior chunks.
      pub fn enqueue(&self, pcm: Vec<f32>, sample_rate: u32);
      pub fn is_playing(&self) -> bool;
      pub fn stop(&self);   // clear the queue
  }
  ```
- Dev command: `#[tauri::command] async fn speak_text(text: String, state: State<'_, AppState>) -> Result<(), String>` — synthesizes and enqueues; used to validate TTS+playback before STT/LLM exist.

> `AudioPlayer` wraps a `rodio::Sink`. Build a `rodio::buffer::SamplesBuffer` (or `SourceExt`) from the f32 PCM at the given sample rate and `sink.append(...)`. Keep the `OutputStream` alive for the app's lifetime (store in `AppState`). Verify the exact `rodio` API against the installed version.

- [ ] **Step 1: Implement `AudioPlayer`** per the interface (no unit test — needs an audio device; validated live in Step 3).

- [ ] **Step 2: Wire the dev `speak_text` command** to `Supertonic::synthesize` → `AudioPlayer::enqueue`, and register it in `lib.rs`. Add a tiny temporary button or console hook, or call it from the devtools console: `window.__TAURI__.core.invoke('speak_text', { text: 'Hallo, wie geht es dir?' })`.

- [ ] **Step 3: Live-verify**

Run: `cargo tauri dev`, open devtools, invoke `speak_text`.
Expected: you hear "Hallo, wie geht es dir?" in German. Try a two-sentence string and confirm it plays through.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Add rodio AudioPlayer and dev speak_text command (TTS audible end-to-end)"
```

---

## Phase 2 — STT in Rust

### Task 6: Whisper STT wrapper

**Files:**
- Create: `src-tauri/src/stt/mod.rs`
- Modify: `src-tauri/Cargo.toml` (`whisper-rs`, `hound`), `src-tauri/src/lib.rs` (`mod stt;`)

**Interfaces:**
- Consumes: `Settings.whisper_model_path`, `Settings.language`.
- Produces:
  ```rust
  pub struct WhisperStt { /* loaded ctx */ }
  impl WhisperStt {
      pub fn load(model_path: &str) -> anyhow::Result<WhisperStt>;
      pub fn is_ready(&self) -> bool;
      /// Transcribe WAV/PCM bytes (any sample rate; resampled to 16k mono) → text.
      pub fn transcribe(&self, wav_bytes: &[u8], lang: &str) -> anyhow::Result<String>;
  }
  ```

> Adapt `whisper-rs`'s standard usage: create `WhisperContext` from the ggml model, decode `wav_bytes` to 16 kHz mono f32 with `hound` (+ simple resample if needed), set `FullParams` with `language = Some(lang)`, run `full`, concatenate segment texts. Verify API against the installed `whisper-rs` version. Choose the GPU build feature here (CUDA or Vulkan) or CPU; keep CPU fallback. **This resolves open decision #2 in the spec.**

- [ ] **Step 1: Model-gated integration test**

In `src-tauri/tests/stt_integration.rs`:
```rust
use tandemlive_lib::{config::Settings, stt::WhisperStt};

#[test]
fn transcribes_when_model_present() {
    let s = Settings::default();
    if !std::path::Path::new(&s.whisper_model_path).exists() {
        eprintln!("skip: no whisper model"); return;
    }
    let stt = WhisperStt::load(&s.whisper_model_path).expect("load");
    // Provide a short known-German WAV fixture at tests/fixtures/hallo.wav.
    let wav = std::fs::read("tests/fixtures/hallo.wav").expect("fixture");
    let text = stt.transcribe(&wav, "de").expect("transcribe");
    assert!(!text.trim().is_empty());
}
```
(Add a short spoken-German WAV fixture, or generate one with the existing Converse `/tts` and reuse it.)

- [ ] **Step 2: Implement `load` + `transcribe`**, then run:

Run: `cargo test --test stt_integration -- --nocapture`
Expected (model present): PASS with non-empty text. (Absent): "skip", passes.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "Add Whisper STT wrapper with model-gated test"
```

---

## Phase 3 — LLM streaming + the pipeline

### Task 7: ChatMessage + conversation history state; `new_conversation`

**Files:**
- Create: `src-tauri/src/llm/message.rs`, `src-tauri/src/llm/mod.rs`, `src-tauri/src/state.rs`
- Modify: `src-tauri/src/commands.rs` (`new_conversation`), `src-tauri/src/lib.rs`

**Interfaces:**
- Produces:
  ```rust
  #[derive(Clone, Serialize, Deserialize)]
  pub struct ChatMessage { pub role: String, pub content: String } // role: "system"|"user"|"assistant"

  pub struct Conversation { messages: Vec<ChatMessage> }
  impl Conversation {
      pub fn new(system_prompt: &str) -> Conversation;
      pub fn push_user(&mut self, content: &str);
      pub fn push_assistant(&mut self, content: &str);
      pub fn messages(&self) -> &[ChatMessage];
  }
  ```
  `AppState` holds `Mutex<Conversation>`, `Settings`, and the loaded `Supertonic`/`WhisperStt`/`AudioPlayer` handles.
- Command: `#[tauri::command] fn new_conversation(system_prompt: Option<String>, voice: Option<String>, state: State<AppState>)` — resets the conversation and current voice.

- [ ] **Step 1: Failing test**

In `src-tauri/src/llm/message.rs` (or `state.rs`):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conversation_tracks_turns_after_system() {
        let mut c = Conversation::new("SYS");
        c.push_user("Hallo");
        c.push_assistant("Guten Tag");
        let m = c.messages();
        assert_eq!(m[0].role, "system");
        assert_eq!(m[1].role, "user");
        assert_eq!(m[1].content, "Hallo");
        assert_eq!(m[2].role, "assistant");
        assert_eq!(m.len(), 3);
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`cargo test conversation_tracks_turns_after_system`).
- [ ] **Step 3: Implement** `ChatMessage` + `Conversation` per the interface.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Wire `new_conversation`** command + `AppState`, register in `lib.rs`.
- [ ] **Step 6: Commit** `git commit -m "Add ChatMessage, Conversation history, new_conversation command"`.

### Task 8: LM Studio streaming client (SSE)

**Files:**
- Create: `src-tauri/src/llm/client.rs`
- Modify: `Cargo.toml` (`reqwest` with `stream`/`json`, `tokio`, `futures-util`, dev: `wiremock`)

**Interfaces:**
- Consumes: `Settings.lm_studio_base_url`, `Settings.lm_studio_model`, `&[ChatMessage]`.
- Produces:
  ```rust
  pub struct LmStudioClient { base_url: String, model: String, http: reqwest::Client }
  impl LmStudioClient {
      pub fn new(base_url: &str, model: &str) -> LmStudioClient;
      pub async fn health(&self) -> bool; // GET /v1/models reachable
      /// POST /v1/chat/completions {stream:true}; invokes `on_token(&str)` per delta.
      pub async fn stream_reply(
          &self, messages: &[ChatMessage],
          on_token: &mut dyn FnMut(&str),
      ) -> anyhow::Result<String>; // returns full concatenated reply
  }
  ```
  SSE parsing: split on lines, ignore blanks, strip `data: ` prefix, stop on `data: [DONE]`, JSON-parse each frame and pull `choices[0].delta.content`.

- [ ] **Step 1: Failing unit test for the SSE frame parser**

Factor the parser into a pure function and test it:
```rust
// fn parse_sse_deltas(chunk: &str) -> (Vec<String>, bool /*done*/)
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_delta_tokens_and_done() {
        let chunk = "data: {\"choices\":[{\"delta\":{\"content\":\"Gu\"}}]}\n\n\
                     data: {\"choices\":[{\"delta\":{\"content\":\"ten\"}}]}\n\n\
                     data: [DONE]\n\n";
        let (tokens, done) = parse_sse_deltas(chunk);
        assert_eq!(tokens, vec!["Gu", "ten"]);
        assert!(done);
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `parse_sse_deltas` + `stream_reply` (buffer the byte stream, split on `\n\n`, feed complete frames to `parse_sse_deltas`, call `on_token`, accumulate).
- [ ] **Step 4: Run the unit test — expect PASS.**
- [ ] **Step 5: Integration test against a mock SSE server**

In `src-tauri/tests/llm_integration.rs`, stand up a `wiremock` server that responds to `POST /v1/chat/completions` with a canned `text/event-stream` body of three `data:` frames + `[DONE]`; assert `stream_reply` returns the concatenated text and `on_token` fired per delta. Run: `cargo test --test llm_integration` — expect PASS.

- [ ] **Step 6: Commit** `git commit -m "Add LM Studio streaming SSE client with mock-server test"`.

### Task 9: Sentence chunker (the core buffering logic)

**Files:**
- Create: `src-tauri/src/pipeline/chunker.rs`

**Interfaces:**
- Produces:
  ```rust
  pub struct SentenceChunker { buf: String, min_len: usize }
  impl SentenceChunker {
      pub fn new(min_len: usize) -> SentenceChunker; // min_len e.g. 12
      /// Feed a token; returns any completed sentences ready for TTS.
      pub fn push(&mut self, token: &str) -> Vec<String>;
      /// End of stream: returns the trailing buffer as a final chunk if non-empty.
      pub fn flush(&mut self) -> Option<String>;
  }
  ```
  Rules: emit when the buffer ends in `.`/`!`/`?` **and** trimmed length ≥ `min_len`, **unless** it looks like an abbreviation (`z.B.`, `usw.`, `d.h.`, `bzw.`, `etc.`, `Dr.`, `Nr.`, or a single-letter+dot). Trailing partial always emitted by `flush`.

- [ ] **Step 1: Failing tests (multiple behaviors)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn feed(c: &mut SentenceChunker, s: &str) -> Vec<String> {
        s.split_inclusive(' ').flat_map(|t| c.push(t)).collect()
    }
    #[test]
    fn emits_on_sentence_end() {
        let mut c = SentenceChunker::new(12);
        let out = feed(&mut c, "Das ist eine gute Frage. ");
        assert_eq!(out, vec!["Das ist eine gute Frage."]);
    }
    #[test]
    fn does_not_split_on_abbreviation() {
        let mut c = SentenceChunker::new(12);
        let mut out = feed(&mut c, "Ich mag Obst, z.B. Äpfel und Birnen. ");
        assert_eq!(out, vec!["Ich mag Obst, z.B. Äpfel und Birnen."]);
        let _ = &mut out;
    }
    #[test]
    fn short_fragment_waits_then_flush() {
        let mut c = SentenceChunker::new(12);
        assert!(feed(&mut c, "Ja. ").is_empty());       // too short, buffered
        assert_eq!(c.flush(), Some("Ja.".to_string())); // emitted at end
    }
    #[test]
    fn flush_emits_trailing_partial() {
        let mut c = SentenceChunker::new(12);
        assert!(feed(&mut c, "Ein unvollendeter Satz ohne Ende").is_empty());
        assert_eq!(c.flush(), Some("Ein unvollendeter Satz ohne Ende".to_string()));
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`cargo test pipeline::chunker`).
- [ ] **Step 3: Implement** `SentenceChunker` per the rules. Detect abbreviation by checking whether the token ending in `.` matches the known list or is `<single letter>.`.
- [ ] **Step 4: Run — expect all PASS.**
- [ ] **Step 5: Commit** `git commit -m "Add sentence chunker with abbreviation and min-length guards"`.

### Task 10: Turn orchestrator (wire it all together with events)

**Files:**
- Create: `src-tauri/src/pipeline/orchestrator.rs`
- Modify: `src-tauri/src/commands.rs` (`submit_turn`), `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `WhisperStt`, `LmStudioClient`, `SentenceChunker`, `Supertonic`, `AudioPlayer`, `Conversation` — all from `AppState`.
- Produces the event-emitting turn:
  ```rust
  // async; borrows an AppHandle to emit events
  pub async fn run_turn(app: tauri::AppHandle, state: &AppState, audio: Vec<u8>);
  ```
  Emits (see spec): `turn:transcript {text}`, `turn:sentence {text}`, `turn:speaking`, `turn:done`, `turn:error {message}`.
- Command: `#[tauri::command] async fn submit_turn(audio: Vec<u8>, app: AppHandle, state: State<AppState>)` — spawns `run_turn` (fire-and-forget), returns immediately.

**`run_turn` sequence:**
1. STT the `audio` → user text; emit `turn:transcript`; `conversation.push_user`.
2. Create a `tokio::sync::mpsc` channel `(sentence_tx, sentence_rx)`. Spawn a **TTS consumer task** (on `spawn_blocking` or a dedicated thread since ORT is blocking): for each sentence from `sentence_rx`, `Supertonic::synthesize` → on the first chunk emit `turn:speaking` once → `AudioPlayer::enqueue`.
3. Drive `LmStudioClient::stream_reply(messages, on_token)`, where `on_token` feeds a `SentenceChunker`; for each completed sentence, emit `turn:sentence` and send it on `sentence_tx`.
4. After the stream ends, `chunker.flush()` → last sentence emitted + sent. Drop `sentence_tx` so the TTS task ends when drained.
5. `conversation.push_assistant(full_reply)`; await the TTS task; emit `turn:done`.
6. Any `Err` at any stage → emit `turn:error {message}`, stop the player queue, return.

- [ ] **Step 1: Integration test of the orchestrator with a mock LLM and stubbed audio**

Gate on models OR inject test doubles. Minimum viable test (no audio device / no models needed): refactor so the sentence-production path is testable — a function `stream_into_sentences(client, messages, chunker, on_sentence)` that, given the wiremock LLM from Task 8 emitting `"Hallo Welt. Wie geht es dir?"` across deltas, calls `on_sentence` exactly with `["Hallo Welt.", "Wie geht es dir?"]`. Assert that. (Full audio path is validated live in Phase 5.)

```rust
#[tokio::test]
async fn streams_two_sentences_from_mock_llm() {
    // start wiremock emitting deltas that concatenate to "Hallo Welt. Wie geht es dir?"
    // ...
    let mut got = Vec::new();
    stream_into_sentences(&client, &msgs, &mut SentenceChunker::new(12),
        &mut |s: &str| got.push(s.to_string())).await.unwrap();
    assert_eq!(got, vec!["Hallo Welt.", "Wie geht es dir?"]);
}
```

- [ ] **Step 2: Run — expect FAIL, then implement** `stream_into_sentences` and the full `run_turn` around it. Run — expect PASS.
- [ ] **Step 3: Wire `submit_turn`** to spawn `run_turn`; register command + events.
- [ ] **Step 4: Commit** `git commit -m "Add turn orchestrator: STT->stream->chunk->TTS->play with turn:* events"`.

---

## Phase 4 — Frontend rewire

### Task 11: `api.js` — invoke wrappers + event listeners

**Files:**
- Modify: `TandemLive/src/api.js` (rewrite)

**Interfaces:**
- Produces (ES module exports consumed by `app.js`):
  ```js
  export async function getHealth();                 // invoke('health')
  export async function getVoices();                 // invoke('list_voices')
  export async function newConversation(systemPrompt, voice); // invoke('new_conversation', {...})
  export async function submitTurn(audioBytes);      // invoke('submit_turn', { audio: Array.from(bytes) })
  export function onTurnEvents({ onTranscript, onSentence, onSpeaking, onDone, onError }); // listen('turn:*')
  ```

- [ ] **Step 1: Rewrite `api.js`**

```js
const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const listen = (...a) => window.__TAURI__.event.listen(...a);

export const getHealth = () => invoke("health");
export const getVoices = () => invoke("list_voices");
export const newConversation = (systemPrompt, voice) =>
  invoke("new_conversation", { systemPrompt, voice });

export async function submitTurn(audioBytes) {
  // audioBytes: Uint8Array of a WAV blob
  await invoke("submit_turn", { audio: Array.from(audioBytes) });
}

export function onTurnEvents({ onTranscript, onSentence, onSpeaking, onDone, onError }) {
  const unlisten = [];
  listen("turn:transcript", (e) => onTranscript?.(e.payload.text)).then((u) => unlisten.push(u));
  listen("turn:sentence",  (e) => onSentence?.(e.payload.text)).then((u) => unlisten.push(u));
  listen("turn:speaking",  () => onSpeaking?.()).then((u) => unlisten.push(u));
  listen("turn:done",      () => onDone?.()).then((u) => unlisten.push(u));
  listen("turn:error",     (e) => onError?.(e.payload.message)).then((u) => unlisten.push(u));
  return () => unlisten.forEach((u) => u());
}
```

- [ ] **Step 2: Commit** `git commit -m "Rewrite api.js onto Tauri invoke + turn:* events"`.

### Task 12: `audio.js` — keep capture, drop playback

**Files:**
- Modify: `TandemLive/src/audio.js`

**Interfaces:**
- Produces: `export async function startRecording()`, `export async function stopRecording(): Promise<Uint8Array>` (WAV bytes). Remove `playWav` (playback is Rust-side now).

- [ ] **Step 1:** Keep the existing `MediaRecorder` capture; change `stopRecording` to resolve a `Uint8Array` of the WAV bytes (`new Uint8Array(await blob.arrayBuffer())`) instead of a Blob. Delete `playWav`.
- [ ] **Step 2: Commit** `git commit -m "audio.js: return WAV bytes from capture, remove client-side playback"`.

### Task 13: `app.js` — event-driven lifecycle + "speaking" state

**Files:**
- Modify: `TandemLive/src/app.js`, `TandemLive/src/styles.css` (add `[data-state="speaking"]` rule)

**Interfaces:**
- Consumes: `api.js` exports (Task 11), `audio.js` (Task 12).

- [ ] **Step 1: Rewire `onRecordClick`** so releasing the record button calls `submitTurn` and the UI is driven by events, not a single awaited result:
  - `ready` → start capture → state `recording`, start timer.
  - `recording` → stop capture → `submitTurn(bytes)` → state `thinking` ("generating reply…"). Add a "Du" turn (filled by `turn:transcript`) and a pending tutor turn.
  - Register `onTurnEvents` once at init:
    - `onTranscript(text)` → fill the "Du" turn.
    - `onSentence(text)` → append to the pending tutor turn (progressive reveal; create the text node on first sentence, append subsequent).
    - `onSpeaking()` → state `speaking`, caption "speaking…".
    - `onDone()` → state `ready`, caption "Record".
    - `onError(msg)` → show `msg` in the tutor turn, state `ready`.
- [ ] **Step 2: Add the CSS** `[data-state="speaking"]` visual (reuse the wave animation used for recording, tinted with the gold accent; keep it distinct from `thinking`).
- [ ] **Step 3: Live-verify** `cargo tauri dev` with LM Studio up: push-to-talk, speak German, watch the "Du" text appear, tutor text stream in sentence-by-sentence, and audio start within ~1–1.5 s while later text is still arriving.
- [ ] **Step 4: Commit** `git commit -m "app.js: event-driven turn lifecycle with progressive text and speaking state"`.

### Task 14: Health + voices + settings parity

**Files:**
- Modify: `TandemLive/src/app.js` (health polling), confirm `settings.js` works unchanged.

**Interfaces:**
- Consumes: `getHealth`, `getVoices`.

- [ ] **Step 1:** Point `refreshHealth` at `getHealth()` (invoke) instead of the old HTTP call; keep the 15 s poll and the status-dot logic (`whisper && tts && llm`). Confirm the settings voice dropdown consumes `getVoices()` (flat array, F/M grouping) unchanged.
- [ ] **Step 2: `health` command** in Rust returns `{ whisper: stt.is_ready(), tts: tts.is_ready(), llm: client.health().await }`.
- [ ] **Step 3: Live-verify** the status dot goes bad when LM Studio is stopped, green when up; voice dropdown lists F1–F5, M1–M5.
- [ ] **Step 4: Commit** `git commit -m "Wire health polling and voices to Rust commands"`.

---

## Phase 5 — Polish

### Task 15: Startup warm-up

**Files:**
- Modify: `src-tauri/src/lib.rs` (spawn on setup)

- [ ] **Step 1:** On app `setup`, spawn a background task that runs one throwaway `Supertonic::synthesize("Guten Tag", default_voice, lang)` and discards the PCM (do NOT enqueue), so the first real turn skips model/GPU init cost. Guard it behind models-present.
- [ ] **Step 2: Live-verify** first real turn latency is noticeably lower than a cold first turn.
- [ ] **Step 3: Commit** `git commit -m "Add TTS warm-up on startup"`.

### Task 16: GPU config, error states, README

**Files:**
- Modify: `src-tauri/src/tts/mod.rs`, `src-tauri/src/stt/mod.rs` (fallback logging), `TandemLive/README.md` (create)

- [ ] **Step 1:** Confirm `use_gpu=false` forces CPU for both STT and TTS and the app still works; confirm GPU EP init failure logs and falls back rather than crashing.
- [ ] **Step 2:** Confirm the error surfaces: stop LM Studio → `turn:error "LLM offline"` (or health-blocked record); rename the whisper model → record disabled with a clear caption.
- [ ] **Step 3:** Write `TandemLive/README.md` (mirrors Converse's model-download instructions + "LM Studio must be running", `cargo tauri dev`).
- [ ] **Step 4: Commit** `git commit -m "GPU fallback, error-state verification, README"`.

---

## Self-Review

**Spec coverage:** goal/latency (whole plan) ✓; single process no .NET (Phase 0–3) ✓; LM Studio sidecar streaming (Task 8) ✓; STT/TTS/orchestration in Rust (Tasks 4/6/10) ✓; sentence chunker with abbreviation+min-length (Task 9) ✓; overlapped TTS/playback (Task 10) ✓; `turn:*` events (Tasks 10–13) ✓; push-to-talk kept (Task 13) ✓; frontend reuse + rewired glue + "speaking" state (Tasks 11–14) ✓; voices flat-array contract (Task 3/14) ✓; models reused + gitignored + not-ready health (Tasks 2/4/6/14/16) ✓; GPU DirectML + CPU fallback + warm-up (Tasks 4/6/15/16) ✓; testing strategy — unit for chunker/SSE/config/history, model-gated integration for STT/TTS, mock-LLM for streaming, live for the loop (throughout) ✓.

**Placeholder scan:** the two "adapt from the official example" tasks (4 and 6) are deliberate — they define the exact wrapper interface we own and forbid inventing ONNX/binding APIs, pointing at authoritative source (Supertonic `rust/` + the .NET `Converse` port) rather than fabricating code. All pure-logic tasks carry real, runnable test + implementation code.

**Type consistency:** `Settings`, `VoiceList`, `Supertonic::synthesize -> (Vec<f32>, u32)`, `AudioPlayer::enqueue(Vec<f32>, u32)`, `ChatMessage{role,content}`, `Conversation`, `LmStudioClient::stream_reply`, `SentenceChunker::{push,flush}`, and the `turn:*` event names are used consistently across tasks and the frontend.

## Open items resolved during execution
- **Whisper GPU backend (CUDA vs Vulkan vs CPU):** decided in Task 6 by what builds cleanest on the target; CPU fallback always retained.
