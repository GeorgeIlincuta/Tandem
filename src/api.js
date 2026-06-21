// Thin client over the Converse API via the Tauri HTTP plugin (reads custom
// response headers and bypasses WebView CORS).
const tauriFetch = () => window.__TAURI__.http.fetch;
const base = (serverUrl) => String(serverUrl).replace(/\/+$/, "");

export async function getHealth(serverUrl) {
  const resp = await tauriFetch()(base(serverUrl) + "/health");
  if (!resp.ok) throw new Error("health HTTP " + resp.status);
  return resp.json();
}

// Returns { voices: string[], default: string } — e.g.
// { voices: ["F1","F2",...,"M5"], default: "M1" }.
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
