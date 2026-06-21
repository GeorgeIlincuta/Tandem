# Tandem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri v2 Windows desktop app, `tandem`, for spoken German conversation practice — record from the laptop mic, send to the Converse API, and hear the tutor's German reply — plus a small per-conversation-voice change in that API.

**Architecture:** Two parts. **(A)** Backend: make `POST /conversations` accept an optional `voice` stored on the session, and have the orchestrator use it for reply TTS. **(B)** Extension: a Tauri v2 app with a minimal Rust shell and a **vanilla** HTML/CSS/JS frontend (no bundler — uses `withGlobalTauri`). The frontend captures mic audio as 16-bit WAV via the Web Audio API and calls the API through the Tauri HTTP plugin (so it can read the `X-User-Transcript`/`X-Assistant-Text` headers and avoid WebView CORS/CSP).

**Tech Stack:** .NET 10 / xUnit (backend); Tauri v2, Rust, `tauri-plugin-http`, vanilla JS (app).

**Two working directories:**
- Backend repo: `C:\LOCAL FILES\Claude Code\DotNet\Converse`
- App project: `C:\LOCAL FILES\Claude Code\Tauri\tandem`

**Prerequisite:** the `GET /voices` endpoint (Converse API) must exist — it is specified in the vorleser plan (Part A). If it isn't implemented yet, do those `GET /voices` tasks first. This plan does not repeat them.

**Known risks (verified by early spikes in Part B):**
1. WebView2 microphone access via `getUserMedia` (Task B2).
2. Multipart upload + custom-header reads via the Tauri HTTP plugin (Task B2).
If either fails, see the fallback notes in Task B2.

---

# Part A — Backend per-conversation voice

Working directory for all Part A tasks: `C:\LOCAL FILES\Claude Code\DotNet\Converse`

## Task A1: Store a voice on the session

**Files:**
- Modify: `Converse.Api/Conversation/ConversationModels.cs`
- Modify: `Converse.Api/Conversation/IConversationStore.cs`
- Modify: `Converse.Api/Conversation/InMemoryConversationStore.cs`
- Test: `Converse.Api.Tests/InMemoryConversationStoreTests.cs`

- [ ] **Step 1: Write the failing test**

In `Converse.Api.Tests/InMemoryConversationStoreTests.cs`, add this test method to the class:
```csharp
    [Fact]
    public void Create_stores_optional_voice()
    {
        var session = _store.Create("prompt", "F1");

        session.Voice.Should().Be("F1");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test --filter FullyQualifiedName~InMemoryConversationStoreTests`
Expected: FAIL — `Create` has no 2-argument overload / `Session` has no `Voice`.

- [ ] **Step 3: Add `Voice` to the session**

In `Converse.Api/Conversation/ConversationModels.cs`, add a property to `Session` (next to `SystemPrompt`):
```csharp
    public string? Voice { get; init; }
```

- [ ] **Step 4: Add `voice` (defaulted) to the store interface + implementation**

In `Converse.Api/Conversation/IConversationStore.cs`, change the `Create` signature to:
```csharp
    Session Create(string? systemPrompt, string? voice = null);
```
In `Converse.Api/Conversation/InMemoryConversationStore.cs`, change the method to:
```csharp
    public Session Create(string? systemPrompt, string? voice = null)
    {
        var session = new Session
        {
            Id = Guid.NewGuid(),
            SystemPrompt = systemPrompt,
            Voice = voice,
            CreatedAt = DateTimeOffset.UtcNow
        };
        _sessions[session.Id] = session;
        return session;
    }
```
(The `voice = null` default keeps all existing one-argument `Create(...)` calls compiling.)

- [ ] **Step 5: Run test to verify it passes**

Run: `dotnet test --filter FullyQualifiedName~InMemoryConversationStoreTests`
Expected: PASS (the new test and all existing store tests).

- [ ] **Step 6: Commit**

```bash
git add Converse.Api/Conversation/ConversationModels.cs Converse.Api/Conversation/IConversationStore.cs Converse.Api/Conversation/InMemoryConversationStore.cs Converse.Api.Tests/InMemoryConversationStoreTests.cs
git commit -m "Store an optional voice on the conversation session"
```

## Task A2: Use the session voice for reply TTS + accept it on create

**Files:**
- Modify: `Converse.Api/Conversation/ConversationOrchestrator.cs:50`
- Modify: `Converse.Api/Endpoints/ConversationEndpoints.cs`
- Test: `Converse.Api.Tests/ConversationOrchestratorTests.cs`

- [ ] **Step 1: Make the fake TTS capture the voice, and write the failing test**

In `Converse.Api.Tests/ConversationOrchestratorTests.cs`, update the `FakeTts` class so its 4-arg overload records the voice:
```csharp
internal sealed class FakeTts : ITextToSpeechService
{
    public bool IsReady => true;
    public int SampleRate => 44100;
    public string? ReceivedText { get; private set; }
    public string? ReceivedVoice { get; private set; }

    public Task<float[]> SynthesizeAsync(string text, CancellationToken ct)
    {
        ReceivedText = text;
        return Task.FromResult(new[] { 0.5f, 0.6f });
    }

    public Task<float[]> SynthesizeAsync(string text, string? voice, string? lang, CancellationToken ct)
    {
        ReceivedVoice = voice;
        return SynthesizeAsync(text, ct);
    }
}
```
Then add this test method to `ConversationOrchestratorTests`:
```csharp
    [Fact]
    public async Task RunTurnAsync_uses_the_session_voice_for_tts()
    {
        var (orchestrator, store, _, tts, _) = Build();
        var session = store.Create(null, "F1");

        await orchestrator.RunTurnAsync(session.Id, Stream.Null, CancellationToken.None);

        tts.ReceivedVoice.Should().Be("F1");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test --filter FullyQualifiedName~ConversationOrchestratorTests`
Expected: FAIL — `ReceivedVoice` is null because the orchestrator calls the 2-arg overload.

- [ ] **Step 3: Make the orchestrator pass the session voice**

In `Converse.Api/Conversation/ConversationOrchestrator.cs`, change the TTS call (currently line 50):
```csharp
        var samples = await tts.SynthesizeAsync(assistantText, session.Voice, null, ct);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test --filter FullyQualifiedName~ConversationOrchestratorTests`
Expected: PASS (new test + all existing orchestrator tests).

- [ ] **Step 5: Accept `voice` on the create endpoint**

In `Converse.Api/Endpoints/ConversationEndpoints.cs`:
- Change the request record at the bottom of the file to:
```csharp
internal sealed record CreateConversationRequest(string? SystemPrompt, string? Voice);
```
- In the `POST /conversations` handler, change the create call to:
```csharp
            var session = store.Create(req.SystemPrompt, req.Voice);
```

- [ ] **Step 6: Build, test, verify**

Run: `dotnet build -clp:ErrorsOnly` then `dotnet test`
Expected: Build succeeded; all tests PASS.

Optional manual check (server + LM Studio running):
```bash
curl -s -X POST http://127.0.0.1:5000/conversations -H "Content-Type: application/json" -d "{\"systemPrompt\":\"Antworte auf Deutsch.\",\"voice\":\"F1\"}"
```
Expected: `201` with `{ "id": "<guid>" }`. A subsequent `/turn` reply uses the F1 voice.

- [ ] **Step 7: Commit and push**

```bash
git add Converse.Api/Conversation/ConversationOrchestrator.cs Converse.Api/Endpoints/ConversationEndpoints.cs Converse.Api.Tests/ConversationOrchestratorTests.cs
git commit -m "Use per-conversation voice for reply TTS; accept voice on create"
git push
```

---

# Part B — Tandem Tauri app

Working directory for all Part B tasks: `C:\LOCAL FILES\Claude Code\Tauri\tandem`

> The frontend is vanilla JS with no automated test harness, so these tasks are
> **create/edit files → run `cargo tauri dev` → verify manually**. The two
> integration unknowns are de-risked up front in Task B2.

## Task B1: Scaffold the Tauri v2 vanilla project

**Files:** generated by the scaffolder, then merged into the `tandem` folder (which already contains `docs/`).

- [ ] **Step 1: Install prerequisites (one-time)**

Ensure installed: **Rust** (`rustup`, MSVC toolchain), **Microsoft C++ Build Tools**, **WebView2** (preinstalled on Windows 11). Then the Tauri tooling:
```bash
cargo install create-tauri-app
cargo install tauri-cli --version "^2.0"
```
Verify: `cargo tauri --version` prints a 2.x version.

- [ ] **Step 2: Scaffold into a temp folder and merge (keeps `docs/`)**

```bash
cd "C:/LOCAL FILES/Claude Code/Tauri"
cargo create-tauri-app _tandem_scaffold --template vanilla --manager cargo --identifier com.converse.tandem -y
```
Then merge the scaffold into `tandem` (PowerShell, preserves the existing `docs/`):
```powershell
robocopy "_tandem_scaffold" "tandem" /E /MOVE
```
(`robocopy` exit codes 0–7 mean success.) Confirm `tandem/` now contains `src/`, `src-tauri/`, and still has `docs/`.

- [ ] **Step 3: Run it**

```bash
cd "C:/LOCAL FILES/Claude Code/Tauri/tandem"
cargo tauri dev
```
Expected: a desktop window opens showing the default Tauri vanilla page. Close it.

- [ ] **Step 4: git init + commit the scaffold**

```bash
cd "C:/LOCAL FILES/Claude Code/Tauri/tandem"
git init
printf "target/\nnode_modules/\n.DS_Store\nThumbs.db\n" > .gitignore
git add .
git commit -m "Scaffold Tauri v2 vanilla project"
```

## Task B2: HTTP plugin + global Tauri + connectivity & mic spike

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- Replace (temporarily): `src/index.html`, `src/main.js`

- [ ] **Step 1: Add the HTTP plugin (Rust)**

```bash
cd "C:/LOCAL FILES/Claude Code/Tauri/tandem/src-tauri"
cargo add tauri-plugin-http
```
In `src-tauri/src/lib.rs`, register the plugin. Find the `tauri::Builder::default()` chain and add `.plugin(tauri_plugin_http::init())` before `.run(...)`, e.g.:
```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
```
(Keep any existing `.plugin(...)`/`.invoke_handler(...)` lines the scaffold added.)

- [ ] **Step 2: Expose the global Tauri API**

In `src-tauri/tauri.conf.json`, in the `"app"` object, add `"withGlobalTauri": true`:
```json
  "app": {
    "withGlobalTauri": true,
    "windows": [
      { "title": "Tandem", "width": 480, "height": 720 }
    ],
    "security": {
      "csp": "default-src 'self'; media-src 'self' blob:; connect-src 'self' http://127.0.0.1:5000 http://localhost:5000"
    }
  }
```
(Merge these keys into the existing `"app"` block; keep other generated fields.)

- [ ] **Step 3: Grant the HTTP scope (capability)**

In `src-tauri/capabilities/default.json`, ensure the `permissions` array includes the HTTP plugin with the local server scope:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability",
  "windows": ["main"],
  "permissions": [
    "core:default",
    {
      "identifier": "http:default",
      "allow": [
        { "url": "http://127.0.0.1:5000/*" },
        { "url": "http://localhost:5000/*" }
      ]
    }
  ]
}
```
(Keep any other permissions the scaffold included; merge the `http:default` entry in.)

- [ ] **Step 4: Spike UI — verify health fetch + mic access**

Replace `src/index.html` with:
```html
<!DOCTYPE html>
<html lang="de">
  <head><meta charset="UTF-8" /><title>Tandem spike</title></head>
  <body>
    <button id="health">Test /health</button>
    <button id="mic">Test microphone</button>
    <pre id="out"></pre>
    <script src="main.js"></script>
  </body>
</html>
```
Replace `src/main.js` with:
```javascript
const out = document.getElementById("out");
const log = (m) => (out.textContent += m + "\n");

document.getElementById("health").addEventListener("click", async () => {
  try {
    const { fetch } = window.__TAURI__.http;
    const resp = await fetch("http://127.0.0.1:5000/health");
    log("health " + resp.status + ": " + (await resp.text()));
  } catch (e) {
    log("health error: " + e);
  }
});

document.getElementById("mic").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    log("mic OK, tracks: " + stream.getAudioTracks().length);
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    log("mic error: " + e);
  }
});
```

- [ ] **Step 5: Verify the spike**

Start the Converse API (so `/health` responds). Run `cargo tauri dev`. In the window:
- Click **Test /health** → expect `health 200: {"whisper":...,"tts":...,"llm":...}`. If you get a CORS/scope error, re-check Step 3's scope and Step 2's `connect-src`.
- Click **Test microphone** → expect `mic OK, tracks: 1`.
  - **If the mic prompt is auto-denied / errors:** this is the known WebView2 risk. Fallback for v1 — capture audio natively in Rust with the `cpal` crate exposed via a Tauri command (`#[tauri::command] fn record() -> Vec<u8>` returning WAV bytes), and call it from JS with `window.__TAURI__.core.invoke('record')`. Stop here and switch to that approach for audio if needed; the rest of the plan's API/UI tasks are unchanged except `audio.js` would call the Rust command instead of `getUserMedia`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add HTTP plugin, global Tauri, CSP/scope; verify health + mic spike"
```

## Task B3: Audio capture and playback (`audio.js`)

**Files:**
- Create: `src/audio.js`

- [ ] **Step 1: Create `src/audio.js`**

```javascript
// Records mono 16-bit PCM WAV from the default mic via Web Audio, and plays WAV.
let audioContext = null;
let mediaStream = null;
let processor = null;
let sourceNode = null;
let chunks = [];
let recordingSampleRate = 44100;
const player = new Audio();

export async function startRecording() {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioContext = new AudioContext();
  recordingSampleRate = audioContext.sampleRate;
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  chunks = [];
  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  sourceNode.connect(processor);
  processor.connect(audioContext.destination);
}

export async function stopRecording() {
  if (processor) processor.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (audioContext) await audioContext.close();

  const samples = flatten(chunks);
  const wav = encodeWav(samples, recordingSampleRate);
  chunks = [];
  processor = sourceNode = mediaStream = audioContext = null;
  return new Blob([wav], { type: "audio/wav" });
}

export function playWav(bytes) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: "audio/wav" });
  player.src = URL.createObjectURL(blob);
  return player.play();
}

function flatten(buffers) {
  let length = 0;
  for (const b of buffers) length += b.length;
  const result = new Float32Array(length);
  let offset = 0;
  for (const b of buffers) {
    result.set(b, offset);
    offset += b.length;
  }
  return result;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s * 32767, true);
    off += 2;
  }
  return buffer;
}
```

> Note: `audio.js` uses ES `export`. Load app scripts as modules (Task B5's
> `index.html` uses `<script type="module">`); `window.__TAURI__` globals are
> still available inside modules.

- [ ] **Step 2: Commit**

```bash
git add src/audio.js
git commit -m "Add WAV mic capture and playback (audio.js)"
```
(Exercised end-to-end in Task B5.)

## Task B4: API client (`api.js`)

**Files:**
- Create: `src/api.js`

- [ ] **Step 1: Create `src/api.js`**

```javascript
// Thin client over the Converse API via the Tauri HTTP plugin (reads custom
// response headers and bypasses WebView CORS).
const tauriFetch = () => window.__TAURI__.http.fetch;
const base = (serverUrl) => String(serverUrl).replace(/\/+$/, "");

export async function getHealth(serverUrl) {
  const resp = await tauriFetch()(base(serverUrl) + "/health");
  if (!resp.ok) throw new Error("health HTTP " + resp.status);
  return resp.json();
}

export async function getVoices(serverUrl) {
  const resp = await tauriFetch()(base(serverUrl) + "/voices");
  if (!resp.ok) throw new Error("voices HTTP " + resp.status);
  return resp.json();
}

export async function createConversation(serverUrl, systemPrompt, voice) {
  const resp = await tauriFetch()(base(serverUrl) + "/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemPrompt, voice }),
  });
  if (!resp.ok) throw new Error("create HTTP " + resp.status);
  const data = await resp.json();
  return data.id;
}

export async function postTurn(serverUrl, id, wavBlob) {
  const form = new FormData();
  form.append("audio", wavBlob, "turn.wav");
  const resp = await tauriFetch()(base(serverUrl) + "/conversations/" + id + "/turn", {
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    let detail = "turn HTTP " + resp.status;
    try { const t = await resp.text(); if (t) detail = t; } catch (_) {}
    throw new Error(detail);
  }
  const userText = decodeURIComponent(resp.headers.get("x-user-transcript") || "");
  const assistantText = decodeURIComponent(resp.headers.get("x-assistant-text") || "");
  const audio = await resp.arrayBuffer();
  return { userText, assistantText, audio };
}
```

- [ ] **Step 2: Verify multipart support (part of the B2 risk)**

This is verified end-to-end in Task B5. If `postTurn` fails because the HTTP
plugin doesn't send `FormData` correctly, the fallback is to send the WAV as the
raw request body with header `Content-Type: audio/wav` AND change the API's
`/turn` endpoint to also accept a raw body — but try `FormData` first; the Tauri
v2 HTTP plugin supports it.

- [ ] **Step 3: Commit**

```bash
git add src/api.js
git commit -m "Add API client (api.js)"
```

## Task B5: UI + wiring (`index.html`, `styles.css`, `settings.js`, `app.js`)

**Files:**
- Replace: `src/index.html`; remove `src/main.js`
- Create: `src/styles.css`, `src/settings.js`, `src/app.js`

- [ ] **Step 1: Create `src/styles.css`**

```css
* { box-sizing: border-box; }
body { font-family: sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; }
header { display: flex; align-items: center; gap: .5rem; padding: .5rem .8rem; border-bottom: 1px solid #ddd; }
header h1 { font-size: 1rem; margin: 0; flex: 1; }
#status { font-size: .85rem; color: #666; }
#transcript { flex: 1; overflow-y: auto; padding: .8rem; }
.msg { margin: .4rem 0; padding: .4rem .6rem; border-radius: .5rem; max-width: 85%; }
.msg.you { background: #e8f0fe; margin-left: auto; }
.msg.tutor { background: #eef7ee; }
.role { font-size: .7rem; color: #888; }
footer { padding: .6rem; border-top: 1px solid #ddd; text-align: center; }
#record { font-size: 1rem; padding: .6rem 1.2rem; cursor: pointer; }
#record.recording { background: #cc3333; color: #fff; }
#line { font-size: .8rem; color: #666; min-height: 1.1em; }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: none; align-items: center; justify-content: center; }
.overlay.open { display: flex; }
.panel { background: #fff; padding: 1rem; border-radius: .6rem; width: 360px; max-width: 90%; }
.panel label { display: block; margin: .6rem 0 .2rem; font-weight: bold; }
.panel input, .panel select, .panel textarea { width: 100%; padding: .35rem; }
.panel textarea { height: 5rem; }
.panel button { margin-top: .8rem; padding: .4rem .8rem; cursor: pointer; }
</style>
```
(Remove the stray trailing `</style>` — that line is not part of the CSS file. The file contents are the CSS rules above only.)

- [ ] **Step 2: Create `src/index.html`**

```html
<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tandem</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header>
      <h1>Tandem</h1>
      <span id="status">…</span>
      <button id="new">New</button>
      <button id="settings-btn">⚙</button>
    </header>

    <div id="transcript"></div>

    <footer>
      <div id="line"></div>
      <button id="record">🎤 Record</button>
    </footer>

    <div class="overlay" id="overlay">
      <div class="panel">
        <h2>Settings</h2>
        <label for="serverUrl">Server URL</label>
        <input id="serverUrl" type="text" />
        <button id="test">Test connection</button> <span id="testStatus"></span>
        <label for="voice">Tutor voice</label>
        <select id="voice"></select>
        <label for="systemPrompt">System prompt</label>
        <textarea id="systemPrompt"></textarea>
        <div>
          <button id="save">Save</button>
          <button id="close">Close</button>
        </div>
      </div>
    </div>

    <script type="module" src="app.js"></script>
  </body>
</html>
```
Then delete the now-unused spike file:
```bash
rm src/main.js
```

- [ ] **Step 3: Create `src/settings.js`**

```javascript
import { getVoices, getHealth } from "./api.js";

const DEFAULTS = {
  serverUrl: "http://127.0.0.1:5000",
  voice: "M1",
  systemPrompt:
    "Du bist ein freundlicher, geduldiger Deutschlehrer. Antworte immer auf Deutsch in kurzen, einfachen Sätzen.",
};

export function loadSettings() {
  return {
    serverUrl: localStorage.getItem("serverUrl") || DEFAULTS.serverUrl,
    voice: localStorage.getItem("voice") || DEFAULTS.voice,
    systemPrompt: localStorage.getItem("systemPrompt") || DEFAULTS.systemPrompt,
  };
}

export function saveSettings(s) {
  localStorage.setItem("serverUrl", s.serverUrl);
  localStorage.setItem("voice", s.voice);
  localStorage.setItem("systemPrompt", s.systemPrompt);
}

// Wires the settings overlay. onSaved() is called after a successful save.
export function initSettingsUI(onSaved) {
  const $ = (id) => document.getElementById(id);
  const overlay = $("overlay");
  const open = () => {
    const s = loadSettings();
    $("serverUrl").value = s.serverUrl;
    $("systemPrompt").value = s.systemPrompt;
    populateVoices(s.serverUrl, s.voice);
    overlay.classList.add("open");
  };
  const close = () => overlay.classList.remove("open");

  async function populateVoices(serverUrl, selected) {
    const sel = $("voice");
    sel.innerHTML = "";
    try {
      const data = await getVoices(serverUrl);
      for (const v of data.voices) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.id + " (" + v.gender + ")";
        sel.appendChild(opt);
      }
      sel.value = selected || data.default;
    } catch (_) {
      const opt = document.createElement("option");
      opt.value = selected;
      opt.textContent = selected + " (voice list unavailable)";
      sel.appendChild(opt);
    }
  }

  $("settings-btn").addEventListener("click", open);
  $("close").addEventListener("click", close);
  $("test").addEventListener("click", async () => {
    $("testStatus").textContent = "…";
    try {
      const h = await getHealth($("serverUrl").value);
      $("testStatus").textContent = h.tts ? "✅ ready" : "⚠️ TTS not ready";
      await populateVoices($("serverUrl").value, $("voice").value);
    } catch (_) {
      $("testStatus").textContent = "❌ unreachable";
    }
  });
  $("save").addEventListener("click", () => {
    saveSettings({
      serverUrl: $("serverUrl").value.trim(),
      voice: $("voice").value,
      systemPrompt: $("systemPrompt").value,
    });
    close();
    onSaved();
  });
}
```

- [ ] **Step 4: Create `src/app.js`**

```javascript
import { loadSettings, initSettingsUI } from "./settings.js";
import { getHealth, createConversation, postTurn } from "./api.js";
import { startRecording, stopRecording, playWav } from "./audio.js";

const $ = (id) => document.getElementById(id);
let conversationId = null;
let recording = false;
let busy = false;

async function refreshHealth() {
  const { serverUrl } = loadSettings();
  try {
    const h = await getHealth(serverUrl);
    const ok = h.whisper && h.tts && h.llm;
    $("status").textContent = ok
      ? "🟢 ready"
      : `🟠 stt:${h.whisper} llm:${h.llm} tts:${h.tts}`;
  } catch (_) {
    $("status").textContent = "🔴 server offline";
  }
}

async function newConversation() {
  const { serverUrl, systemPrompt, voice } = loadSettings();
  $("transcript").innerHTML = "";
  conversationId = null;
  try {
    conversationId = await createConversation(serverUrl, systemPrompt, voice);
    setLine("New conversation started.");
  } catch (e) {
    setLine("Couldn't start a conversation: " + e.message);
  }
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "you" ? "you" : "tutor");
  div.innerHTML = `<div class="role">${role}</div>${escapeHtml(text)}`;
  $("transcript").appendChild(div);
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function setLine(text) {
  $("line").textContent = text;
}

async function toggleRecord() {
  if (busy) return;
  if (!recording) {
    if (!conversationId) await newConversation();
    if (!conversationId) return;
    try {
      await startRecording();
      recording = true;
      $("record").textContent = "■ Stop";
      $("record").classList.add("recording");
      setLine("Recording… click to stop.");
    } catch (e) {
      setLine("Microphone unavailable: " + e.message);
    }
  } else {
    recording = false;
    $("record").textContent = "🎤 Record";
    $("record").classList.remove("recording");
    busy = true;
    setLine("Thinking…");
    try {
      const wav = await stopRecording();
      const { serverUrl } = loadSettings();
      const { userText, assistantText, audio } = await postTurn(serverUrl, conversationId, wav);
      addMessage("you", userText || "(couldn't transcribe)");
      addMessage("tutor", assistantText);
      await playWav(audio);
      setLine("");
    } catch (e) {
      setLine("Turn failed: " + e.message);
    } finally {
      busy = false;
    }
  }
}

$("record").addEventListener("click", toggleRecord);
$("new").addEventListener("click", newConversation);
initSettingsUI(() => { refreshHealth(); newConversation(); });

refreshHealth();
newConversation();
```

- [ ] **Step 5: Run and verify end-to-end**

Start the Converse API (with LM Studio running, a German model loaded). Run
`cargo tauri dev`. In the window:
1. Header shows `🟢 ready`.
2. Open ⚙ → Test connection ✅; voice dropdown lists M1–M5/F1–F5; set a voice +
   German system prompt; Save.
3. Click **🎤 Record**, say a German sentence, click **■ Stop** → "Thinking…" →
   your German and the tutor's German appear; the reply plays in the chosen voice.
4. Take another turn → the reply reflects the prior turn (history works).
5. **New** → transcript clears, fresh session.
6. Stop LM Studio → a turn shows "Turn failed: …" and the header reflects it.

If the mic step fails here, apply the cpal fallback from Task B2 Step 5.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add Tandem UI and wiring (conversation, transcript, settings)"
```

## Task B6: README + finalize

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# Tandem

A Tauri (v2) Windows desktop app for **practising spoken German**. Record from
your laptop mic, and an LLM "tutor" replies in spoken German, using the local
[Converse](https://github.com/GeorgeIlincuta/Converse) API.

## Requirements
- The Converse API running locally with `/health` showing `whisper`, `llm`, and
  `tts` all true (LM Studio running with a German-capable model).
- Rust toolchain + Tauri CLI v2 (`cargo install tauri-cli --version "^2.0"`).

## Run
```bash
cargo tauri dev
```
In **Settings (⚙)**: set the server URL (default `http://127.0.0.1:5000`), test
the connection, choose the tutor voice, and edit the German system prompt.
Then click **🎤 Record**, speak, and **■ Stop** to hear the reply.

## How it works
- Vanilla JS frontend (no bundler; uses `withGlobalTauri`).
- `audio.js` records 16-bit WAV via the Web Audio API; `api.js` calls the
  Converse API through the Tauri HTTP plugin (so it can read the
  `X-User-Transcript` / `X-Assistant-Text` headers).
- The tutor voice is sent on `POST /conversations` and used for reply TTS.

Localhost-only and click-to-toggle recording in v1.
```

- [ ] **Step 2: Final end-to-end checklist**

Re-run the Task B5 Step 5 checks once more end-to-end to confirm a clean state.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Add README; finalize Tandem v1"
```

---

## Self-review

**Spec coverage:**
- Record (click-to-toggle) → turn → play reply → Tasks B3, B5. ✓
- Chat-style transcript from X-User-Transcript / X-Assistant-Text → B4 (decode) + B5 (render). ✓
- New conversation → B5 (`newConversation`). ✓
- Settings overlay: server URL, voice (from /voices), system prompt, Test
  connection, localStorage → B5 (`settings.js`). ✓
- Header /health status → B5 (`refreshHealth`). ✓
- Tauri v2 + vanilla + HTTP plugin + `withGlobalTauri` + CSP/scope → B1, B2. ✓
- Mic = laptop default input via getUserMedia; WebView2 risk + cpal fallback → B2, B3. ✓
- Per-conversation voice (backend) → Part A (A1, A2), unit-tested. ✓
- GET /voices dependency → noted as prerequisite (vorleser plan). ✓
- Errors (server down, mic denied, non-200) → B4 (throw + header read) + B5
  (status line / header). ✓
- Manual test checklist → B5 Step 5, B6 Step 2. ✓

**Deviations / risks (intentional, flagged):**
- The two integration unknowns (WebView2 mic, HTTP-plugin multipart) are
  de-risked by the Task B2 spike before the full UI is built; cpal and raw-body
  fallbacks are documented inline.
- Tauri scaffold/config exact fields come from the official `create-tauri-app`
  output; this plan only adds well-known deltas (HTTP plugin, `withGlobalTauri`,
  CSP, capability scope) on top — verify against the generated files when running.

**Placeholder scan:** none — every step has complete file content or exact commands.

**Type/contract consistency:** `createConversation(serverUrl, systemPrompt, voice)`
→ body `{ systemPrompt, voice }` matches `CreateConversationRequest(SystemPrompt,
Voice)` (Task A2). `postTurn` returns `{ userText, assistantText, audio }`, which
`app.js` consumes by those names. `loadSettings()` returns `{ serverUrl, voice,
systemPrompt }`, used consistently in `app.js`/`settings.js`. The backend
`Session.Voice` (A1) is read by the orchestrator (A2).
```
