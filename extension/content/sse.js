export async function streamDesign(shimUrl, token, payload, onEvent, signal, path = "/design") {
  const res = await fetch(`${shimUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream",
               "Authorization": `Bearer ${token}` },
    body: JSON.stringify(payload), signal,
  });
  if (!res.ok || !res.body) throw new Error(`request failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep); buf = buf.slice(sep + 2);
      const data = frame.split("\n").filter(l => l.startsWith("data:"))
                        .map(l => l.slice(5).replace(/^ /, "")).join("\n");
      if (data) { try { onEvent(JSON.parse(data)); } catch {} }
    }
  }
}

// Read-only history fetches (same Bearer gate as /design). `fetchHistory` lists the repo's sessions;
// `fetchHistoryDetail` returns one session's normalized, render-ready event list (§6 shapes). Both
// are provider-scoped: the shim reads the selected provider's transcript store (claude's
// ~/.claude/projects vs codex's rollout tree), so the chosen provider rides along as `?provider=`.
async function getJson(shimUrl, token, path) {
  const res = await fetch(`${shimUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}
const provQ = (provider) => (provider ? `?provider=${encodeURIComponent(provider)}` : "");
export async function fetchHistory(shimUrl, token, provider) {
  return (await getJson(shimUrl, token, `/history${provQ(provider)}`)).sessions || [];
}
export async function fetchHistoryDetail(shimUrl, token, id, provider) {
  return (await getJson(shimUrl, token, `/history/${encodeURIComponent(id)}${provQ(provider)}`)).events || [];
}
