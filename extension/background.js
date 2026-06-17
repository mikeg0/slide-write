// Slide Write — background service worker.
// Owns the per-origin config in chrome.storage and serves get/set to options, popup, and the
// content script. No network access here (§10.4: "background.js … No network.").

const KEY = "slidewrite";

async function load() {
  const o = await chrome.storage.local.get(KEY);
  return o[KEY] || { origins: {} };
}
async function save(cfg) {
  await chrome.storage.local.set({ [KEY]: cfg });
}

// --- Dynamic per-origin content scripts (§8.1) ---
// Localhost origins are covered by the static content_scripts entry; every other origin gets a
// runtime-granted host permission (requested in options/popup, on the user gesture) plus a
// dynamically registered copy of inject.js. Registration lives here so options, popup, and the
// startup reconcile share one implementation.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
function isLocalOrigin(origin) {
  try { return LOCAL_HOSTS.has(new URL(origin).hostname); } catch { return true; }
}
// Match patterns can't carry a port, so a granted origin covers every port on that host — same as
// the static localhost entry. inject.js stays inert on un-enabled origins, so that's harmless.
function originPattern(origin) {
  try { const u = new URL(origin); return `${u.protocol}//${u.hostname}/*`; } catch { return origin + "/*"; }
}
const scriptId = (origin) => "sw:" + origin;

async function registerOrigin(origin) {
  if (isLocalOrigin(origin)) return { ok: true, skipped: "static localhost content script" };
  if (!(await chrome.permissions.contains({ origins: [originPattern(origin)] })))
    return { ok: false, error: "host permission not granted" };
  await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] }).catch(() => {});
  await chrome.scripting.registerContentScripts([{
    id: scriptId(origin), matches: [originPattern(origin)], js: ["content/inject.js"], runAt: "document_idle",
  }]);
  return { ok: true };
}

async function unregisterOrigin(origin, { dropPermission = false } = {}) {
  await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] }).catch(() => {});
  if (dropPermission && !isLocalOrigin(origin))
    await chrome.permissions.remove({ origins: [originPattern(origin)] }).catch(() => {});
  return { ok: true };
}

// Registrations persist across browser restarts but are cleared on extension update/reload, and the
// user can revoke a host permission from chrome://extensions at any time — reconcile storage,
// permissions, and the script registry whenever the worker (re)starts.
async function reconcile() {
  const cfg = await load();
  const want = Object.keys(cfg.origins || {}).filter((o) => cfg.origins[o].enabled && !isLocalOrigin(o));
  const have = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  const wantIds = new Set(want.map(scriptId));
  const stale = have.map((s) => s.id).filter((id) => id.startsWith("sw:") && !wantIds.has(id));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});
  for (const origin of want) await registerOrigin(origin).catch(() => {});
}
chrome.runtime.onStartup.addListener(reconcile);
chrome.runtime.onInstalled.addListener(reconcile);

// Message API. Config shape:
//   { geminiKey?, pollInterval?, origins: { "<origin>": { enabled, token, shimUrl?, autoReload?, autoCommit?, model?, imageInstructions? } } }
// `autoCommit` defaults to true when absent (only an explicit false disables the shim's per-run commit).
// `geminiKey` and `pollInterval` (seconds; liveness-poll cadence while the panel is open) are global;
// everything else is per-origin.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    // Visible-tab capture is the one privileged step the content script can't do itself (chrome.tabs
    // lives here). It is NOT network (§10.4) — just the current viewport as a PNG, which the picker
    // then crops to the selected element. activeTab + the localhost host_permissions cover it; it
    // fails gracefully (returns ok:false) on restricted pages.
    if (msg && msg.type === "captureTab") {
      try {
        const windowId = _sender && _sender.tab ? _sender.tab.windowId : undefined;
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
        return sendResponse({ ok: true, dataUrl });
      } catch (e) { return sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    }
    const cfg = await load();
    switch (msg && msg.type) {
      case "getAll":
        return sendResponse(cfg);
      case "getOrigin":
        // Merge the global settings (Gemini key, poll interval) into the per-origin config the
        // content script consumes.
        return sendResponse(cfg.origins[msg.origin]
          ? { ...cfg.origins[msg.origin], geminiKey: cfg.geminiKey || "", pollInterval: cfg.pollInterval || 0 }
          : null);
      case "setGemini":
        cfg.geminiKey = msg.value || "";
        await save(cfg);
        return sendResponse({ ok: true });
      case "setPollInterval":
        cfg.pollInterval = Number(msg.value) || 0;  // seconds; 0/blank → client default
        await save(cfg);
        return sendResponse({ ok: true });
      case "setOrigin": {
        cfg.origins[msg.origin] = { ...(cfg.origins[msg.origin] || {}), ...msg.value };
        await save(cfg);
        // Keep the dynamic-script registry in step with `enabled` (no-op for localhost). The host
        // permission itself was requested by options/popup on the user gesture before this message.
        const registration = cfg.origins[msg.origin].enabled
          ? await registerOrigin(msg.origin).catch((e) => ({ ok: false, error: String(e?.message || e) }))
          : await unregisterOrigin(msg.origin);
        return sendResponse({ ok: true, value: cfg.origins[msg.origin], registration });
      }
      case "deleteOrigin": {
        delete cfg.origins[msg.origin];
        await save(cfg);
        await unregisterOrigin(msg.origin, { dropPermission: true });
        return sendResponse({ ok: true });
      }
      case "openOptions": {
        // Content scripts can't call openOptionsPage directly — relay through here (the gear button).
        chrome.runtime.openOptionsPage();
        return sendResponse({ ok: true });
      }
      default:
        return sendResponse(null);
    }
  })();
  return true; // keep the channel open for the async response
});

// The chat UI is now a side panel (sidepanel.html). setPanelBehavior makes the toolbar icon open it
// directly, so no action.onClicked handler is needed (and the panel renders its own "set up" state
// for un-wired origins — no openSetup detour). Re-applied on startup/install in case it was reset.
function initSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior)
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onStartup.addListener(initSidePanel);
chrome.runtime.onInstalled.addListener(initSidePanel);
initSidePanel();

// Keyboard shortcut → open the side panel for the active tab's window. A command counts as the user
// gesture chrome.sidePanel.open() requires (Chrome 116+). There's no programmatic close — the
// panel's own ✕ closes it.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch { /* needs a user gesture / Chrome 116+ */ }
});
