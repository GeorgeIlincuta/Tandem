import { loadSettings, initSettingsUI } from "./settings.js";
import { getHealth, createConversation, postTurn } from "./api.js";
import { startRecording, stopRecording, playWav } from "./audio.js";

const $ = (id) => document.getElementById(id);
const recordbar = () => $("recordbar");

let conversationId = null;
let recState = "ready"; // 'ready' | 'recording' | 'thinking'
let elapsed = 0;
let timerId = null;

function setState(state) {
  recState = state;
  recordbar().dataset.state = state;
}

// ---------- Window controls (custom titlebar) ----------
function initWindowControls() {
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!win) return;
  $("win-min").addEventListener("click", () => win.minimize());
  $("win-max").addEventListener("click", () => win.toggleMaximize());
  $("win-close").addEventListener("click", () => win.close());
}

// ---------- Health ----------
async function refreshHealth() {
  const { serverUrl } = loadSettings();
  const dot = $("status-dot");
  const label = $("status-label");
  try {
    const h = await getHealth(serverUrl);
    const ok = h.whisper && h.tts && h.llm;
    dot.classList.toggle("bad", !ok);
    label.textContent = ok ? "ready" : `stt:${h.whisper} llm:${h.llm} tts:${h.tts}`;
  } catch (_) {
    dot.classList.add("bad");
    label.textContent = "offline";
  }
}

// ---------- Transcript ----------
function addTurn(speaker, text) {
  const turn = document.createElement("div");
  turn.className = "turn " + (speaker === "du" ? "du" : "tutor");
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = speaker === "du" ? "Du" : "Tutor";
  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text;
  turn.append(label, body);
  $("transcript").appendChild(turn);
  scrollToBottom();
  return turn;
}

// A tutor turn whose text is a typing indicator until the reply arrives.
function addPendingTutorTurn() {
  const turn = document.createElement("div");
  turn.className = "turn tutor";
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = "Tutor";
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.innerHTML = "<span></span><span></span><span></span>";
  turn.append(label, typing);
  $("transcript").appendChild(turn);
  scrollToBottom();
  return turn;
}

function resolveTutorTurn(turn, text) {
  const typing = turn.querySelector(".typing");
  if (typing) typing.remove();
  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text;
  turn.appendChild(body);
  scrollToBottom();
}

function scrollToBottom() {
  const t = $("transcript");
  t.scrollTop = t.scrollHeight;
}

// ---------- Recording timer ----------
function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function startTimer() {
  elapsed = 0;
  $("rec-caption").textContent = `listening · ${fmt(0)} · Stop`;
  timerId = setInterval(() => {
    elapsed += 1;
    $("rec-caption").textContent = `listening · ${fmt(elapsed)} · Stop`;
  }, 1000);
}
function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}

// ---------- Conversation ----------
async function newConversation() {
  const { serverUrl, systemPrompt, voice } = loadSettings();
  $("transcript").innerHTML = "";
  conversationId = null;
  try {
    conversationId = await createConversation(serverUrl, systemPrompt, voice);
  } catch (e) {
    addTurn("tutor", "Couldn't start a conversation: " + e.message);
  }
}

// ---------- Record toggle ----------
async function onRecordClick() {
  if (recState === "thinking") return;

  if (recState === "ready") {
    if (!conversationId) await newConversation();
    if (!conversationId) return;
    try {
      await startRecording();
      setState("recording");
      startTimer();
    } catch (e) {
      $("rec-caption").textContent = "mic unavailable";
      addTurn("tutor", "Microphone unavailable: " + e.message);
    }
    return;
  }

  // recState === "recording" -> stop and send
  stopTimer();
  setState("thinking");
  $("rec-caption").textContent = "generating reply…";
  let pending;
  try {
    const wav = await stopRecording();
    const { serverUrl } = loadSettings();
    addTurn("du", "…");
    const duTurn = $("transcript").lastElementChild;
    pending = addPendingTutorTurn();

    const { userText, assistantText, audio } = await postTurn(serverUrl, conversationId, wav);
    duTurn.querySelector(".text").textContent = userText || "(couldn't transcribe)";
    resolveTutorTurn(pending, assistantText || "(no reply)");
    await playWav(audio);
  } catch (e) {
    if (pending) resolveTutorTurn(pending, "Turn failed: " + e.message);
    else addTurn("tutor", "Turn failed: " + e.message);
  } finally {
    setState("ready");
    $("rec-caption").textContent = "Record";
  }
}

// ---------- Init ----------
initWindowControls();
$("rec-btn").addEventListener("click", onRecordClick);
$("new-btn").addEventListener("click", newConversation);
initSettingsUI(() => {
  refreshHealth();
  newConversation();
});

refreshHealth();
newConversation();
setInterval(refreshHealth, 15000);
