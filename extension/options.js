// Slide Write — options page. Per-origin config rows { origin, enabled, token, shimUrl? }.
// All reads/writes go through the background config store.
const send = (msg) => chrome.runtime.sendMessage(msg);
const $ = (id) => document.getElementById(id);

function normOrigin(s) {
  try { return new URL(s.trim()).origin; } catch { return s.trim().replace(/\/+$/, ""); }
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
      <div class="origin">${origin}</div>
      <div class="controls">
        <label><input type="checkbox" class="en" ${c.enabled ? "checked" : ""}/> enabled</label>
        <label><input type="checkbox" class="ar" ${c.autoReload ? "checked" : ""}/> auto-reload</label>
        <button class="save primary">Save</button>
        <button class="del danger">Delete</button>
      </div>
      <div class="fields">
        <label>Token</label><input type="password" class="tok" value="${c.token || ""}"/>
        <label>Shim URL</label><input type="text" class="url" value="${c.shimUrl || ""}" placeholder="http://localhost:4040"/>
      </div>`;
    row.querySelector(".save").addEventListener("click", async () => {
      await send({ type: "setOrigin", origin, value: {
        enabled: row.querySelector(".en").checked,
        autoReload: row.querySelector(".ar").checked,
        token: row.querySelector(".tok").value.trim(),
        shimUrl: row.querySelector(".url").value.trim() || undefined,
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

$("add").addEventListener("click", async () => {
  const origin = normOrigin($("a-origin").value);
  if (!origin) return;
  await send({ type: "setOrigin", origin, value: {
    enabled: $("a-enabled").checked,
    autoReload: $("a-autoreload").checked,
    token: $("a-token").value.trim(),
    shimUrl: $("a-url").value.trim() || undefined,
  }});
  $("a-origin").value = $("a-token").value = $("a-url").value = "";
  render();
});

render();
