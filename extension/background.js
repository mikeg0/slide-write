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

// Toggle the panel in a tab's content script. If the content script isn't mounted (origin not
// enabled, or the page was opened before it was enabled), the message has no receiver and rejects —
// guide the user to setup instead of failing silently (the symptom: "the icon does nothing").
async function togglePanel(tab) {
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" });
  } catch {
    openSetup(tab); // no receiving end → not wired up on this origin yet
  }
}

// Open the options page with this tab's origin pre-filled in the "add origin" form, so the user
// lands ready to enable it. (openOptionsPage can't carry a query param, so create the tab directly.)
function openSetup(tab) {
  let origin = "";
  try { origin = tab && tab.url ? new URL(tab.url).origin : ""; } catch { /* chrome://, etc. */ }
  const url = chrome.runtime.getURL("options.html") + (origin ? `?origin=${encodeURIComponent(origin)}` : "");
  chrome.tabs.create({ url });
}

// Toolbar icon click → toggle (or, if not yet wired up, open setup). (No default_popup, so
// action.onClicked fires.)
chrome.action.onClicked.addListener((tab) => { togglePanel(tab); });

// Keyboard shortcut → same path against the active tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  togglePanel(tab);
});
