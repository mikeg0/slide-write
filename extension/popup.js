// Slide Write — popup. Quick enable/disable + token for the active tab's origin, then confirm
// against GET <shimUrl>/meta so you can see which repo this tab is wired to (§11).
const send = (msg) => chrome.runtime.sendMessage(msg);
const $ = (id) => document.getElementById(id);

let ORIGIN = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { ORIGIN = tab && tab.url ? new URL(tab.url).origin : null; } catch { ORIGIN = null; }
  if (!ORIGIN || !/^https?:/.test(ORIGIN)) {
    $("origin").textContent = "(not a web page)";
    $("enabled").disabled = $("token").disabled = $("save").disabled = true;
    return;
  }
  $("origin").textContent = ORIGIN;
  const c = (await send({ type: "getOrigin", origin: ORIGIN })) || {};
  $("enabled").checked = !!c.enabled;
  $("token").value = c.token || "";
}

// Non-localhost origins need a runtime-granted host permission; must be the FIRST await in the
// click handler (chrome.permissions.request needs the user gesture). Patterns can't carry a port,
// so the grant covers the whole host.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
async function requestHost(origin) {
  try {
    const u = new URL(origin);
    if (LOCAL_HOSTS.has(u.hostname)) return true;
    return await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch { return false; }
}

$("save").addEventListener("click", async () => {
  if (!ORIGIN) return;
  const value = { enabled: $("enabled").checked, token: $("token").value.trim() };
  const status = $("status");
  if (value.enabled && !(await requestHost(ORIGIN))) {
    status.className = "status err"; status.textContent = "permission denied for this origin";
    return;
  }
  await send({ type: "setOrigin", origin: ORIGIN, value });
  if (!value.enabled) { status.className = "status"; status.textContent = "disabled on this origin"; return; }
  const stored = (await send({ type: "getOrigin", origin: ORIGIN })) || {};
  const shimUrl = (stored.shimUrl || ORIGIN + "/_slidewrite").replace(/\/$/, "");
  status.className = "status"; status.textContent = "checking…";
  try {
    const r = await fetch(`${shimUrl}/meta`, { headers: { Authorization: `Bearer ${value.token}` } });
    if (!r.ok) { status.className = "status err"; status.textContent = `meta ${r.status} — check token`; return; }
    const m = await r.json();
    status.className = "status ok"; status.textContent = `wired to ${m.project} @ ${m.branch}`;
  } catch (e) {
    status.className = "status err"; status.textContent = "agent unreachable";
  }
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

init();
