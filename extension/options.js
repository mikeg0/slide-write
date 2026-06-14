// Slide Write — options page. Per-origin config rows { origin, enabled, token, shimUrl? }.
// All reads/writes go through the background config store.
const send = (msg) => chrome.runtime.sendMessage(msg);
const $ = (id) => document.getElementById(id);

function normOrigin(s) {
  try { return new URL(s.trim()).origin; } catch { return s.trim().replace(/\/+$/, ""); }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Non-localhost origins need a runtime-granted host permission (manifest grants localhost only).
// Must be the FIRST await in a click handler — chrome.permissions.request needs the user gesture.
// Match patterns can't carry a port, so the grant covers the whole host (like the localhost entry).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
async function requestHost(origin) {
  try {
    const u = new URL(origin);
    if (LOCAL_HOSTS.has(u.hostname)) return true;
    return await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch { return false; }
}

async function render() {
  const cfg = await send({ type: "getAll" });
  const list = $("list");
  list.textContent = "";
  const origins = Object.keys(cfg.origins || {}).sort();
  if (!origins.length) {
    list.append(Object.assign(document.createElement("p"), { className: "hint", textContent: "No origins configured yet." }));
    return;
  }
  for (const origin of origins) {
    const c = cfg.origins[origin];
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="origin">${c.name ? `${esc(c.name)} <span class="hint" style="font-weight:400">${origin}</span>` : origin}</div>
      <div class="controls">
        <label><input type="checkbox" class="en" ${c.enabled ? "checked" : ""}/> enabled</label>
        <label title="When on, reload the page after any run that changed a file — for apps without hot-reload"><input type="checkbox" class="ar" ${c.autoReload ? "checked" : ""}/> auto-reload on save</label>
        <label title="When off, runs leave their edits uncommitted in the repo's working tree"><input type="checkbox" class="ac" ${c.autoCommit !== false ? "checked" : ""}/> auto-commit</label>
        <button class="save primary">Save</button>
        <button class="del danger">Delete</button>
      </div>
      <div class="fields">
        <label>Name</label><input type="text" class="name" value="${esc(c.name || "")}" placeholder="optional label"/>
        <label>Token</label><input type="password" class="tok" value="${esc(c.token || "")}"/>
        <label>Shim URL</label><input type="text" class="url" value="${esc(c.shimUrl || "")}" placeholder="http://localhost:4040"/>
        <label>Image steps (override)</label><textarea class="imgsteps" placeholder="Optional override — prefer the repo's CLAUDE.md / a skill. Layered on top (path, naming, DB write, resize…)">${esc(c.imageInstructions || "")}</textarea>
      </div>`;
    row.querySelector(".save").addEventListener("click", async () => {
      const enabled = row.querySelector(".en").checked;
      if (enabled && !(await requestHost(origin)))
        return flash(row.querySelector(".save"), "Permission denied");
      await send({ type: "setOrigin", origin, value: {
        name: row.querySelector(".name").value.trim(),
        enabled,
        autoReload: row.querySelector(".ar").checked,
        autoCommit: row.querySelector(".ac").checked,
        token: row.querySelector(".tok").value.trim(),
        shimUrl: row.querySelector(".url").value.trim() || undefined,
        imageInstructions: row.querySelector(".imgsteps").value.trim(),
      }});
      flash(row.querySelector(".save"), "Saved");
    });
    row.querySelector(".del").addEventListener("click", async () => {
      await send({ type: "deleteOrigin", origin });
      render();
    });
    list.append(row);
  }
}

function flash(btn, text) {
  const old = btn.textContent; btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}

$("a-gen").addEventListener("click", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  $("a-token").value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  $("a-token").type = "text";
});

// Global Gemini key — one secret shared across all origins.
async function loadGemini() { $("gemini-key").value = (await send({ type: "getAll" })).geminiKey || ""; }
$("gemini-save").addEventListener("click", async () => {
  await send({ type: "setGemini", value: $("gemini-key").value.trim() });
  flash($("gemini-save"), "Saved");
});

// Global liveness-poll cadence (seconds). Blank field shows the 5s default but stores 0 → client default.
async function loadPoll() { const v = (await send({ type: "getAll" })).pollInterval; $("poll-interval").value = v ? String(v) : ""; }
$("poll-save").addEventListener("click", async () => {
  const n = Math.max(1, Math.round(Number($("poll-interval").value) || 5));
  $("poll-interval").value = String(n);
  await send({ type: "setPollInterval", value: n });
  flash($("poll-save"), "Saved");
});

$("add").addEventListener("click", async () => {
  const origin = normOrigin($("a-origin").value);
  if (!origin) return;
  const enabled = $("a-enabled").checked;
  if (enabled && !(await requestHost(origin)))
    return flash($("add"), "Permission denied");
  await send({ type: "setOrigin", origin, value: {
    name: $("a-name").value.trim(),
    enabled,
    autoReload: $("a-autoreload").checked,
    autoCommit: $("a-autocommit").checked,
    token: $("a-token").value.trim(),
    shimUrl: $("a-url").value.trim() || undefined,
    imageInstructions: $("a-imgsteps").value.trim(),
  }});
  $("a-name").value = $("a-origin").value = $("a-token").value = $("a-url").value = $("a-imgsteps").value = "";
  render();
});

// When opened from the toolbar icon on an un-wired origin, pre-fill the add form with it.
try {
  const pending = new URL(location.href).searchParams.get("origin");
  if (pending && !$("a-origin").value) { $("a-origin").value = pending; $("a-enabled").checked = true; }
} catch { /* no/invalid query param */ }

render();
loadGemini();
loadPoll();
