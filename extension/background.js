// Slide Write — background service worker (ES module: see manifest "background.type": "module").
// Owns (1) the per-origin config in chrome.storage, served to options/popup/side panel; (2) the §8.1
// dynamic per-origin content scripts for the default content-script picker; and (3) the OPT-IN
// chrome.debugger / Chrome DevTools Protocol picker — selected per origin (`debuggerPicker`). The two
// pickers coexist: the side panel routes to whichever the origin opted into, and both post the same
// "sw-picker-state" / "sw-element-picked" messages and §7 element contract. No network access here
// (§10.4: "background.js … No network.").
import { swCapture } from "./content/capture.js";

const KEY = "slidewrite";
const MAX_ELEMENTS = 5;                   // mirror panel.js MAX_ELEMENTS; cap auto-disarms the picker
const CANCEL_BINDING = "__swCancelPick";  // CDP Runtime binding the in-page Escape listener calls
const SW_CAPTURE_SRC = swCapture.toString(); // shipped into the page via Runtime.callFunctionOn

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

// --- Opt-in CDP element picker (§8.5) --------------------------------------------------------------
// The alternative picker, used only by origins that opt into `debuggerPicker`. Driven via
// chrome.debugger / the Chrome DevTools Protocol — NOT a content script. The native inspector overlay
// (Overlay.setInspectMode) is browser-drawn, descends into iframes (cross-origin included), and is
// reached only through chrome.debugger, which lives in the worker. The `debugger` permission is
// REQUIRED in the manifest (Chrome forbids `debugger` as optional), so chrome.debugger is always
// available here — but it still only attaches when the user arms the picker on a debuggerPicker origin.
//
// Promise wrappers around the callback-style debugger API (works on every Chrome that ships it).
function dbgAttach(target, version) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, version, () => {
      const e = chrome.runtime.lastError;
      e ? reject(new Error(e.message)) : resolve();
    });
  });
}
function dbgSend(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (res) => {
      const e = chrome.runtime.lastError;
      e ? reject(new Error(e.message)) : resolve(res);
    });
  });
}
function dbgDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => { void chrome.runtime.lastError; resolve(); });
  });
}

let picker = null; // { tabId, count } while armed; null otherwise. One picker at a time.

function reportState(active) { chrome.runtime.sendMessage({ type: "sw-picker-state", active }).catch(() => {}); }
function reportError(message) { chrome.runtime.sendMessage({ type: "sw-picker-error", message }).catch(() => {}); }

// Map a chrome.debugger.attach failure to an actionable message. The headline case (the user asked
// for this): DevTools open on the tab holds the one debugger slot, so attach fails — tell them how.
function attachHint(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("already attached") || m.includes("another debugger") || m.includes("devtools"))
    return "Can't start the picker: DevTools (or another debugger) is attached to this tab. Close DevTools on this tab — or move it to a separate window — then click 🎯 again.";
  if (m.includes("cannot attach") || m.includes("cannot access") || m.includes("restricted") || m.includes("chrome"))
    return "Can't pick on this page (a browser/internal page). Open your app's page and try again.";
  return "Couldn't start the picker: " + msg;
}

const inspectConfig = {
  mode: "searchForNode",
  highlightConfig: {
    contentColor: { r: 70, g: 70, b: 160, a: 0.15 },
    paddingColor: { r: 70, g: 70, b: 160, a: 0.1 },
    marginColor: { r: 70, g: 70, b: 160, a: 0.1 },
    borderColor: { r: 70, g: 70, b: 160, a: 0.9 },
    showInfo: true,
  },
};
// Inspect mode auto-disables after each inspectNodeRequested; re-issue it to STAY ARMED for the next
// pick (§7: consecutive picks up to the 5-element cap).
const armInspect = (target) => dbgSend(target, "Overlay.setInspectMode", inspectConfig);

// Escape-to-cancel without a content script: a CDP Runtime binding (a page global) plus a capture-
// phase keydown listener installed via Runtime.evaluate. Pressing Esc in the page calls the binding,
// which surfaces here as Runtime.bindingCalled. Best-effort per top frame; the 🎯 toggle always works.
async function installEscape(target) {
  const expr =
    "(()=>{if(window.__swEscInstalled)return;window.__swEscInstalled=true;" +
    "window.addEventListener('keydown',function(e){if(e.key==='Escape'&&typeof " + CANCEL_BINDING +
    "==='function'){try{" + CANCEL_BINDING + "('')}catch(_){}}},true);})()";
  await dbgSend(target, "Runtime.evaluate", { expression: expr }).catch(() => {});
}

async function startPicker(tabId) {
  if (tabId == null) { reportState(false); return; }
  if (picker && picker.tabId === tabId) { reportState(true); return; }  // already armed here
  if (picker) await stopPicker();                                       // armed elsewhere → move

  const target = { tabId };
  try {
    await dbgAttach(target, "1.3");
  } catch (e) {
    reportError(attachHint(e && e.message));
    reportState(false);
    return;
  }
  picker = { tabId, count: 0 };
  try {
    await dbgSend(target, "DOM.enable");
    await dbgSend(target, "Overlay.enable");
    await dbgSend(target, "Page.enable");
    await dbgSend(target, "Runtime.enable");
    await dbgSend(target, "Runtime.addBinding", { name: CANCEL_BINDING });
    await installEscape(target);
    await armInspect(target);
    reportState(true);
  } catch (e) {
    await stopPicker();
    reportError("Couldn't start the picker: " + (e && e.message));
    reportState(false);
  }
}

async function stopPicker() {
  if (!picker) return;
  const target = { tabId: picker.tabId };
  picker = null;   // null first so late onEvent/onDetach for this tab no-op
  try { await dbgSend(target, "Overlay.setInspectMode", { mode: "none" }); } catch { /* detaching anyway */ }
  await dbgDetach(target);
}

// Auto-copy the picked element's full selector to the clipboard — same "copy full path" affordance
// the §8.3 content-script picker does (both copy on every pick). The inspect event
// (Overlay.inspectNodeRequested) carries no modifier state, so there's nothing to gate on anyway.
// Runs in the page's top frame with userGesture:true to synthesize the
// transient activation the async Clipboard API requires; the app tab is focused (the user just
// clicked it), so writeText resolves. Best-effort: a missing clipboard permission / unfocused doc is
// swallowed (the pick still flows to the panel regardless).
async function copyPathToClipboard(target, text) {
  if (!text) return;
  const expr = "navigator.clipboard.writeText(" + JSON.stringify(text) + ").then(()=>true,()=>false)";
  await dbgSend(target, "Runtime.evaluate", { expression: expr, userGesture: true, awaitPromise: true }).catch(() => {});
}

// Capture the picked node's pixels via CDP: box model → top-frame clip → Page.captureScreenshot.
// Cleaner than the old captureVisibleTab+crop (device-accurate, handles iframe offsets, no DOM math).
async function captureNodeShot(target, backendNodeId) {
  const box = await dbgSend(target, "DOM.getBoxModel", { backendNodeId }).catch(() => null);
  const border = box && box.model && box.model.border;
  if (!border) return null;
  const xs = [border[0], border[2], border[4], border[6]];
  const ys = [border[1], border[3], border[5], border[7]];
  const x = Math.min(...xs), y = Math.min(...ys);
  const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
  if (w < 1 || h < 1) return null;
  const scale = Math.min(1, 1400 / Math.max(w, h));  // cap the long edge ~1400px, like the old crop
  const res = await dbgSend(target, "Page.captureScreenshot", {
    format: "png", clip: { x, y, width: w, height: h, scale }, captureBeyondViewport: true,
  }).catch(() => null);
  if (!res || !res.data) return null;
  return { dataUrl: "data:image/png;base64," + res.data, w: Math.round(w), h: Math.round(h) };
}

async function handlePick(backendNodeId) {
  if (!picker) return;
  const target = { tabId: picker.tabId };
  let ctx = null;
  try {
    // resolveNode → a RemoteObject bound to the node's OWN frame context, so swCapture runs inside
    // the iframe for iframe nodes — domPath/text/imageDataUrl all work cross-frame.
    const resolved = await dbgSend(target, "DOM.resolveNode", { backendNodeId });
    const objectId = resolved && resolved.object && resolved.object.objectId;
    if (objectId) {
      const r = await dbgSend(target, "Runtime.callFunctionOn", {
        objectId, functionDeclaration: SW_CAPTURE_SRC, arguments: [{ value: true }], returnByValue: true,
      });
      ctx = r && r.result && r.result.value;
    }
  } catch { /* capture failed — skip this pick, stay armed */ }
  if (!ctx) { if (picker) await armInspect(target).catch(() => {}); return; }

  await copyPathToClipboard(target, ctx.fullPath);

  const shot = await captureNodeShot(target, backendNodeId).catch(() => null);
  if (shot) { ctx.screenshotDataUrl = shot.dataUrl; ctx.screenshotW = shot.w; ctx.screenshotH = shot.h; }
  chrome.runtime.sendMessage({ type: "sw-element-picked", ctx }).catch(() => {});

  if (!picker) return;
  picker.count++;
  if (picker.count >= MAX_ELEMENTS) { await stopPicker(); reportState(false); }
  else await armInspect(target).catch(async () => { await stopPicker(); reportState(false); });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!picker || source.tabId !== picker.tabId) return;
  if (method === "Overlay.inspectNodeRequested") {
    handlePick(params.backendNodeId);
  } else if (method === "Runtime.bindingCalled" && params && params.name === CANCEL_BINDING) {
    stopPicker().then(() => reportState(false));   // Escape
  }
});

// User clicked "Cancel" on the debug banner, or DevTools opened mid-pick → reset so the 🎯 un-sticks.
chrome.debugger.onDetach.addListener((source) => {
  if (picker && source.tabId === picker.tabId) { picker = null; reportState(false); }
});

// Message API. Config shape:
//   { geminiKey?, pollInterval?, origins: { "<origin>": { enabled, token, shimUrl?, autoReload?, autoCommit?, model?, imageInstructions?, debuggerPicker? } } }
// `debuggerPicker` (default false) opts the origin into the chrome.debugger picker instead of the
// content-script one (the `debugger` permission is declared required in the manifest — see §8.5).
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
    // CDP picker control (from the side panel, debugger-picker mode) — drives the inspector on a tab.
    if (msg && msg.type === "sw-picker-start") {
      await startPicker(msg.tabId);
      return sendResponse({ ok: true });
    }
    if (msg && msg.type === "sw-picker-stop") {
      // Only stop if it's the tab we're armed on (tab-switch cleanup sends the OLD tab id).
      if (picker && (msg.tabId == null || picker.tabId === msg.tabId)) { await stopPicker(); reportState(false); }
      else if (msg.tabId == null) reportState(false);
      return sendResponse({ ok: true });
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

// The chat UI is a side panel (sidepanel.html). The <all_urls> host permission satisfies
// chrome.tabs.captureVisibleTab (the element-screenshot crop) without needing the per-tab activeTab
// grant, so we can open the panel straight from the toolbar icon via setPanelBehavior. The setting
// PERSISTS across reloads, so set it explicitly on startup/install rather than relying on a prior
// value. There's no programmatic close — the panel's own ✕ closes it.
function initSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior)
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onStartup.addListener(initSidePanel);
chrome.runtime.onInstalled.addListener(initSidePanel);
initSidePanel();

// Keyboard shortcut → open the side panel for the active tab's window (Chrome 116+; needs the gesture).
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch { /* needs a user gesture / Chrome 116+ */ }
});
