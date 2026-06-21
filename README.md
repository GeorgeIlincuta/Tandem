# Tandem

A Tauri (v2) Windows desktop app for **practising spoken German**. Record from
your laptop mic, and an LLM "tutor" replies in spoken German, using the local
Converse API.

> **Requires the Converse API backend.** This app is just the frontend — it does
> nothing on its own. You must have the [Converse API](https://github.com/GeorgeIlincuta/Converse)
> running locally (it handles speech-to-text, the LLM tutor, and text-to-speech).

## Requirements

- The **[Converse API](https://github.com/GeorgeIlincuta/Converse)** running
  locally with `GET /health` showing `whisper`, `llm`, and `tts` all `true`
  (LM Studio running with a German-capable model).
- **Rust** toolchain + **Tauri CLI v2** (`cargo install tauri-cli --version "^2.0"`)
  and the Microsoft C++ Build Tools / WebView2 (preinstalled on Windows 11).

## Run

```bash
cargo tauri dev
```

In **Settings (⚙)**: set the server URL (default `http://127.0.0.1:5000`), test
the connection, choose the tutor voice, and edit the German system prompt. Then
click the **mic** button, speak, and click **Stop** to hear the reply.

## How it works

- Vanilla HTML/CSS/JS frontend (no bundler; uses `withGlobalTauri`).
- Custom 36px titlebar (the OS frame is hidden via `decorations: false`); the
  app draws its own minimize / maximize / close controls.
- `audio.js` records mono 16-bit WAV via the Web Audio API; `api.js` calls the
  Converse API through the **Tauri HTTP plugin** (so it can read the
  `X-User-Transcript` / `X-Assistant-Text` headers and bypass WebView CORS).
- The tutor voice (`F1`–`F5`, `M1`–`M5` from `GET /voices`) is sent on
  `POST /conversations` and used for the reply TTS. Gender is inferred from the
  `F`/`M` prefix for the settings dropdown.

## UI states

The record bar has three states driven by `data-state` on `.recordbar`:
**ready** (press to speak), **recording** (live waveform + timer + Stop), and
**thinking** (the tutor turn shows a typing indicator until the reply arrives,
then the reply WAV auto-plays). See `design_main_window/` for the visual spec.

Localhost-only and click-to-toggle recording in v1.
