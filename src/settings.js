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

// The Converse API returns voice ids like "F1".."M5"; gender is encoded in the
// leading letter. Turn an id into a friendly label, e.g. "F2 — Female 2".
function genderOf(id) {
  const c = (id || "").charAt(0).toUpperCase();
  if (c === "F") return "Female";
  if (c === "M") return "Male";
  return "Voice";
}

function labelFor(id) {
  const num = id.replace(/^\D+/, "");
  return `${id} — ${genderOf(id)}${num ? " " + num : ""}`;
}

// Builds the <select>, grouping by gender (Female first, then Male, then any
// other). Selects `selected` if present, otherwise the server default.
function renderVoices(sel, ids, defaultId, selected) {
  sel.innerHTML = "";
  const groups = { Female: [], Male: [], Voice: [] };
  for (const id of ids) groups[genderOf(id)].push(id);

  for (const groupName of ["Female", "Male", "Voice"]) {
    const list = groups[groupName];
    if (!list.length) continue;
    const og = document.createElement("optgroup");
    og.label = groupName;
    for (const id of list) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = labelFor(id);
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }

  const want = selected && ids.includes(selected) ? selected : defaultId;
  if (want) sel.value = want;
}

// Wires the settings overlay. onSaved() is called after a successful save.
export function initSettingsUI(onSaved) {
  const $ = (id) => document.getElementById(id);
  const overlay = $("overlay");

  async function populateVoices(serverUrl, selected) {
    const sel = $("voice");
    try {
      const data = await getVoices(serverUrl);
      const ids = Array.isArray(data.voices) ? data.voices : [];
      renderVoices(sel, ids, data.default, selected);
    } catch (_) {
      sel.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = selected || "";
      opt.textContent = (selected || "(default)") + " — voice list unavailable";
      sel.appendChild(opt);
    }
  }

  const open = () => {
    const s = loadSettings();
    $("serverUrl").value = s.serverUrl;
    $("systemPrompt").value = s.systemPrompt;
    $("test-status").textContent = "";
    populateVoices(s.serverUrl, s.voice);
    overlay.classList.add("open");
  };
  const close = () => overlay.classList.remove("open");

  $("settings-btn").addEventListener("click", open);
  $("close-btn").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  $("test-btn").addEventListener("click", async () => {
    $("test-status").textContent = "…";
    try {
      const h = await getHealth($("serverUrl").value.trim());
      const ok = h.whisper && h.tts && h.llm;
      $("test-status").textContent = ok
        ? "✅ ready"
        : `⚠️ stt:${h.whisper} llm:${h.llm} tts:${h.tts}`;
      await populateVoices($("serverUrl").value.trim(), $("voice").value);
    } catch (_) {
      $("test-status").textContent = "❌ unreachable";
    }
  });

  $("save-btn").addEventListener("click", () => {
    saveSettings({
      serverUrl: $("serverUrl").value.trim(),
      voice: $("voice").value,
      systemPrompt: $("systemPrompt").value,
    });
    close();
    onSaved();
  });
}
