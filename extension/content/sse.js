export async function streamDesign(shimUrl, token, payload, onEvent, signal) {
  const res = await fetch(`${shimUrl}/design`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream",
               "Authorization": `Bearer ${token}` },
    body: JSON.stringify(payload), signal,
  });
  if (!res.ok || !res.body) throw new Error(`design failed: ${res.status}`);
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
// `fetchHistoryDetail` returns one session's normalized, render-ready event list (§6 shapes).
async function getJson(shimUrl, token, path) {
  const res = await fetch(`${shimUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}
export async function fetchHistory(shimUrl, token) {
  return (await getJson(shimUrl, token, "/history")).sessions || [];
}
export async function fetchHistoryDetail(shimUrl, token, id) {
  return (await getJson(shimUrl, token, `/history/${encodeURIComponent(id)}`)).events || [];
}
