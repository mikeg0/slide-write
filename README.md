# Slide Write

**A portable, project-agnostic AI design assistant.** A browser extension injects an
element-picker + chat overlay into your running app. Click an element or type a request; a tiny
local **shim** drives **`claude`** headless against your repo; your dev server hot-reloads; the
change appears live — with **zero changes to the target project's source.**

The shim runs `claude` the same way your editor already does (headless, streaming) and reuses your
existing `~/.claude` login — **no API key, no Docker, no reverse proxy.** The browser reaches the
shim over **VS Code's built-in port forwarding**, so the exact same setup works whether your code
is on the laptop or on a remote server, on **Windows / macOS / Linux**.

> Two deliverables:
> 1. **`shim/`** — a cross-platform Node CLI: runs `claude` in a repo and streams the run as SSE on `127.0.0.1:<port>`.
> 2. **`extension/`** — a Manifest V3 browser extension: the universal, framework-agnostic UI.

This README is self-contained and buildable: it inlines every contract, the shim's core code, and
the extension spec. It's written to be implemented by **Claude Code** — see [§12](#12-build-order-for-claude).

---

## Table of contents

1. [What you get](#1-what-you-get)
2. [Repository layout](#2-repository-layout)
3. [Architecture](#3-architecture)
4. [Why this reaches everywhere](#4-why-this-reaches-everywhere)
5. [The shim (`shim/`)](#5-the-shim-shim)
6. [The SSE event contract](#6-the-sse-event-contract)
7. [The element-capture contract](#7-the-element-capture-contract)
8. [The browser extension (`extension/`)](#8-the-browser-extension-extension)
9. [Discovery & routing](#9-discovery--routing)
10. [Security model](#10-security-model)
11. [Quick start](#11-quick-start)
12. [Build order for Claude](#12-build-order-for-claude)
13. [Fallback: public-hostname access via a reverse proxy](#13-fallback-public-hostname-access-via-a-reverse-proxy)
14. [Prior art](#14-prior-art)

---

## 1. What you get

- A **browser extension** with a toolbar button / shortcut that injects a chat panel into the app's
  page. Type a prompt ("make the primary button green") → the shim drives `claude` → the running
  app hot-reloads → you see it in seconds.
- A **Markup mode**: hover to highlight elements, click one to describe a change anchored to it; the
  clicked element's context (tag, classes, text, DOM path) is sent so `claude` finds the source.
- The panel streams **thinking, tool calls, file edits, tool output, a final summary, and run
  stats** live over SSE, and shows the commit each run makes.
- **Reusable across projects.** The shim is generic; per-project knowledge comes from the target
  repo's own `CLAUDE.md`. Adding it to a project is: run the shim pointed at the repo, enable the
  origin in the extension. **No edits to the project's source.**

Single-developer, trusted-local tool ([§10](#10-security-model)).

---

## 2. Repository layout

```
.
├── README.md                       # this spec
├── CLAUDE.md                       # guidance for implementing/extending this repo
│
├── shim/                           # the local agent: claude → SSE on loopback
│   ├── package.json                # bin: "slide-write"; dep: @anthropic-ai/claude-agent-sdk
│   └── slide-write.mjs             # the CLI (HTTP server + SDK run loop + SSE mapping + commit)
│
└── extension/                      # the Manifest V3 browser extension (the universal UI)
    ├── manifest.json               # host_permissions: localhost; content script on localhost
    ├── background.js               # config store (chrome.storage); options/popup messaging
    ├── content/
    │   ├── inject.js               # bootstrap: mount the Shadow-DOM widget on enabled origins
    │   ├── picker.js               # capture-phase element picker (§8.3)
    │   ├── panel.js                # chat transcript + composer (renders the §6 events)
    │   └── sse.js                  # fetch + getReader SSE reader (§8.2, verbatim)
    ├── options.html
    ├── options.js                  # per-origin config: enabled + token + shim URL
    ├── popup.html
    ├── popup.js                    # quick enable/disable + "wired to <project>" via /meta
    └── styles.css                  # injected into the Shadow root only
```

No Docker, no compose overlay, no reverse-proxy config — the shim is a plain process and the
transport is VS Code's port forwarding.

---

## 3. Architecture

The shim binds **loopback on the machine where the code lives** (your laptop, or a remote
server/WSL/container). **VS Code's port forwarding** makes that loopback port — and your app's dev
port — appear at `localhost:<port>` on the machine where the browser runs. So the extension always
talks to `http://localhost:<port>`, and **local dev and remote dev look identical** to it.

```mermaid
flowchart TB
    subgraph UI["UI machine — Win11 / macOS / Linux desktop (where the browser runs)"]
        direction TB
        PAGE["app page · http://localhost:5173"]
        EXT["browser extension<br/>content script: element picker + chat panel + SSE reader"]
        PAGE -.- EXT
    end

    subgraph CODE["Code host — same laptop, OR a remote server / WSL / container"]
        direction TB
        SHIM["slide-write shim · 127.0.0.1:4040<br/>HTTP + SSE"]
        CLAUDE["claude (headless, Agent SDK)<br/>reuses ~/.claude · runs as you (non-root)"]
        DEV["app dev server · Vite, … (unchanged)"]
        REPO[("repo")]
        SHIM --> CLAUDE
        CLAUDE -- "edits files" --> REPO
        REPO -- "file watch → HMR" --> DEV
    end

    EXT == "fetch + SSE → http://localhost:4040/design<br/>(VS Code port-forwards 4040 + 5173 to localhost)" ==> SHIM
    DEV == "HMR · hot-reloaded UI" ==> PAGE

    classDef hot fill:#eaeaff,stroke:#4646a0;
    classDef repo fill:#eafbea,stroke:#3f7f3f;
    class SHIM,CLAUDE hot;
    class REPO repo;
```

The load-bearing property: **the shim and the dev server share the repo through the filesystem.**
`claude` writes files; the project's own dev server sees the change and hot-reloads. The shim never
imports the project's code.

---

## 4. Why this reaches everywhere

VS Code forwards loopback ports **identically** in every remote mode and on every OS — that's the
entire trick. Bind the shim to `127.0.0.1`, open your app via its forwarded `localhost` URL, and:

| Setup | Where the shim + code live | How the browser reaches the shim |
|---|---|---|
| **Local** (Win / macOS / Linux) | the laptop | direct `localhost:4040` (forwarding is a no-op) |
| **Remote-SSH** → a Linux server | the server | VS Code forwards over its SSH channel |
| **Windows + WSL** | WSL | VS Code forwards WSL → Windows localhost |
| **Dev Container** | the container | VS Code forwards container → host |
| **Codespaces / Tunnels** | the cloud VM | VS Code's forwarded URL |

From the browser's point of view everything is `localhost`, so there's **one extension code path
and one shim** — no topology awareness, no per-OS install. The one habit that keeps it uniform: in
remote dev, **open the app through its VS Code-forwarded `localhost` URL**, not a public hostname.
(If you must use a public hostname, see the [reverse-proxy fallback](#13-fallback-public-hostname-access-via-a-reverse-proxy).)

Credential portability is the `claude` CLI's job: the shim runs `claude` (via the Agent SDK), which
already knows where your login lives on each OS — so reusing your subscription works the same on
Windows, macOS, and Linux with no API key.

---

## 5. The shim (`shim/`)

A small Node CLI. It serves HTTP+SSE on loopback and drives `claude` headless via the Agent SDK.
Because it runs as **you (non-root)**, it can use `permissionMode: "bypassPermissions"` directly —
no permission-prompt callback, no root workarounds. Edits are written as your user, so they're
yours.

### 5.1 `shim/package.json`
```json
{
  "name": "slide-write",
  "version": "0.1.0",
  "type": "module",
  "bin": { "slide-write": "slide-write.mjs" },
  "dependencies": { "@anthropic-ai/claude-agent-sdk": "^0.3.168" }
}
```
The SDK reuses `~/.claude` automatically (or `ANTHROPIC_API_KEY` if set). Run with
`node shim/slide-write.mjs …`, or `npm i -g ./shim` then `slide-write …`, or `npx`.
*(Equivalent zero-dep alternative: shell out to `claude -p --output-format stream-json` and reframe
its JSONL as SSE — same event mapping. The SDK is used here for typed messages.)*

### 5.2 `shim/slide-write.mjs`
```js
#!/usr/bin/env node
// slide-write — drive `claude` headless in a repo, stream the run as SSE on loopback.
// Reuses ~/.claude (no API key). Binds 127.0.0.1 only; reach it via VS Code port forwarding.
import http from "node:http";
import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const PORT    = +(arg("port",   process.env.SLIDEWRITE_PORT   ?? 4040));
const REPO    = resolve(arg("repo", process.cwd()));
const TOKEN   = arg("token",  process.env.SLIDEWRITE_TOKEN ?? "");
const ORIGIN  = arg("origin", process.env.SLIDEWRITE_ALLOWED_ORIGIN ?? "*"); // app origin, e.g. http://localhost:5173
const DEBUG   = process.argv.includes("--debug") || !!process.env.SW_DEBUG;  // log each SDK message to stderr
const VERSION = "0.1.0";

const PREAMBLE =
  "You are editing a web app live from within its running dev environment. Your edits land on the " +
  "repo at the working directory and the app's own dev server hot-reloads, so changes appear in the " +
  "browser within seconds.\n\n" +
  "FIRST, read the repo's CLAUDE.md (and README) for THIS project's conventions — where styling " +
  "lives, where components/screens live, the framework in use. Follow them.\n\n" +
  "- Make the SMALLEST focused change that satisfies the request, in the spirit of the existing code.\n" +
  "- Reuse existing tokens/components/patterns; don't add dependencies unless asked.\n" +
  "- Do NOT edit Dockerfiles, CI, or anything under .claude / .env / credentials.\n" +
  "- Keep schema/model changes ADDITIVE; never rename/drop/retype an existing column.\n" +
  "- When done, reply with one or two sentences describing exactly what you changed.";

const git = (...a) => new Promise(r => execFile("git", ["-C", REPO, ...a], (_e, out) => r((out || "").trim())));
// NB: parse porcelain UNtrimmed — `" M file"` starts with a space the status column needs.
const porcelainPaths = () => new Promise(r => execFile("git", ["-C", REPO, "status", "--porcelain", "-uall"],
  (_e, out) => r((out || "").split("\n").filter(Boolean).map(l => l.slice(3)))));
const cors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true"); // for https→localhost (PNA); harmless otherwise
};
const authed = (req) => !!TOKEN && req.headers.authorization === `Bearer ${TOKEN}`;
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const sse  = (res, type, data = {}) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(b)); });

let busy = false;

function buildPrompt({ prompt = "", screen, element }) {
  const parts = [String(prompt).trim()];
  if (screen) parts.push(`\n[Current screen: ${screen}]`);
  if (element) {
    const ctx = Object.fromEntries(Object.entries({
      tag: element.tag, id: element.id, class: element.className,
      text: element.text, domPath: element.domPath, rect: element.rect,
    }).filter(([, v]) => v));
    if (Object.keys(ctx).length)
      parts.push("\n[The user clicked this on-screen element and is referring to it]\n" +
        JSON.stringify(ctx, null, 2) +
        "\nUse the class names / text / DOM path to locate the source and matching styles, then edit there.");
  }
  return parts.join("\n");
}

const detailOf = (name, i = {}) =>
  name === "Bash" ? (i.command || "") :
  ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name) ? (i.file_path || i.notebook_path || "") :
  name === "Grep" || name === "Glob" ? (i.pattern || "") : JSON.stringify(i).slice(0, 600);

function resultText(content) {
  let t = typeof content === "string" ? content
    : Array.isArray(content) ? content.map(b => b?.type === "text" ? b.text : JSON.stringify(b)).join("\n")
    : String(content ?? "");
  const trunc = t.length > 4000; return { text: t.slice(0, 4000).trim(), trunc };
}

// Core: drive one design run. `emit(type, data)` sends an SSE event; `aborted()` lets the caller
// cancel (client disconnect). Exported so the HTTP handler and tests share one implementation.
export async function runDesign(body, emit, aborted = () => false) {
  const tool = {}; let streamedText = false, hadError = false;
  const dirty0 = new Set(await porcelainPaths());
  for await (const m of query({ prompt: buildPrompt(body), options: {
    cwd: REPO, permissionMode: "bypassPermissions",  // runs as you (non-root) → allowed, no callback
    allowDangerouslySkipPermissions: true,           // required by the SDK alongside bypassPermissions
    includePartialMessages: true, settingSources: ["project"], systemPrompt: PREAMBLE, maxTurns: 40,
  } })) {
    if (aborted()) return;
    if (DEBUG) console.error("SDK", m.type, m.subtype ?? "");
    if (m.type === "system" && m.subtype === "init") emit("start", { sessionId: m.session_id, model: m.model });
    else if (m.type === "stream_event" && m.event?.type === "content_block_delta") {
      const d = m.event.delta;
      if (d.type === "text_delta" && d.text) { streamedText = true; emit("delta", { text: d.text }); }
      else if (d.type === "thinking_delta" && d.thinking) emit("thinking_delta", { text: d.thinking });
    }
    else if (m.type === "assistant") for (const b of m.message.content ?? []) {
      if (b.type !== "tool_use") continue;
      tool[b.id] = b.name;
      if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(b.name))
        emit("file_edit", { tool: b.name, path: (b.input?.file_path || "").replace(REPO + "/", ""), id: b.id });
      else emit("tool", { tool: b.name, detail: detailOf(b.name, b.input), id: b.id });
    }
    else if (m.type === "user") for (const b of (Array.isArray(m.message.content) ? m.message.content : [])) {
      if (b.type !== "tool_result") continue;
      const { text, trunc } = resultText(b.content);
      emit("tool_result", { tool: tool[b.tool_use_id], id: b.tool_use_id, text, isError: !!b.is_error, truncated: trunc });
    }
    else if (m.type === "result") {
      hadError = !!m.is_error;
      emit("result", { isError: hadError, numTurns: m.num_turns, durationMs: m.duration_ms,
        totalCostUsd: m.total_cost_usd, usage: m.usage, result: streamedText ? null : m.result });
    }
  }
  if (!hadError) {                                                   // commit only what THIS run changed; no push
    const changed = (await porcelainPaths()).filter(p => !dirty0.has(p));
    if (changed.length) {
      const subj = (body.prompt || "design change").split("\n")[0].slice(0, 72);
      await git("add", "--", ...changed);
      await git("-c", "user.name=Slide Write", "-c", "user.email=slide-write@local", "commit", "-m", `slide-write: ${subj}`);
      emit("commit", { sha: await git("rev-parse", "--short", "HEAD"), count: changed.length });
    }
  }
  emit("done");
}

async function design(req, res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
  if (busy) { sse(res, "error", { message: "a run is already in progress" }); sse(res, "done"); return res.end(); }
  busy = true;
  try {
    const body = JSON.parse((await readBody(req)) || "{}");
    await runDesign(body, (t, d) => sse(res, t, d), () => req.destroyed);
  } catch (e) { sse(res, "error", { message: String(e?.message || e) }); sse(res, "done"); }
  finally { busy = false; res.end(); }
}

function serve() {
  http.createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/health") return json(res, 200, { ok: true });
    if (!authed(req)) return json(res, 401, { error: "unauthorized" });
    if (path === "/meta")
      return json(res, 200, {
        project: basename(REPO), repoDir: REPO, version: VERSION,
        branch: await git("rev-parse", "--abbrev-ref", "HEAD"),
        dirty: !!(await git("status", "--porcelain")),
      });
    if (path === "/history" && req.method === "GET")        // list this repo's past `claude` sessions
      return json(res, 200, { sessions: await listHistory() });
    if (path.startsWith("/history/") && req.method === "GET") {  // one session, normalized to §6 events
      const id = decodeURIComponent(path.slice("/history/".length));
      const data = await readHistory(id);                   // null for a bad/missing id → 404
      return data ? json(res, 200, data) : json(res, 404, { error: "not found" });
    }
    if (path === "/design" && req.method === "POST") return design(req, res);
    json(res, 404, { error: "not found" });
  }).listen(PORT, "127.0.0.1", () =>
    console.error(`slide-write → http://127.0.0.1:${PORT}  repo=${REPO}  origin=${ORIGIN}`));
}

// Start the server only when run directly (so tests can import runDesign without listening).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
```

**Validated against `@anthropic-ai/claude-agent-sdk` 0.3.168** (the run logic lives in the exported `runDesign()`; the HTTP server only starts when the file is run directly, so tests can import `runDesign`). **SDK version caveat:** message/block shapes (`stream_event` deltas, `tool_use`/`tool_result`
blocks) can drift across SDK versions. The loop dispatches on `m.type` defensively; verify against
the installed `@anthropic-ai/claude-agent-sdk` during the phase-1 smoke test ([§12](#12-build-order-for-claude)).

---

## 6. The SSE event contract

Every frame is **one JSON object on a `data:` line**; the client reads only `data:`. Each has a
`type`. This is the interface between `shim/` and `extension/`.

| `type` | payload | client action |
|---|---|---|
| `start` | `{sessionId, model}` | status row "Started · `<model>`" |
| `delta` | `{text}` | append to the current assistant bubble |
| `thinking_delta` | `{text}` | append to the current thinking bubble |
| `tool` | `{tool, detail, id}` | compact tool row (`detail` = command/file/pattern) |
| `file_edit` | `{tool, path, id}` | edit row (✏️ `path`) |
| `tool_result` | `{tool, id, text, isError, truncated}` | collapsible output (auto-open on error) |
| `result` | `{isError, numTurns, durationMs, totalCostUsd, usage, result}` | stats footer; `result` is the final-text fallback if no deltas streamed |
| `commit` | `{sha, count}` | green "Committed `<sha>` · N files" |
| `error` | `{message}` | error row |
| `done` | `{}` | end of stream; clear the busy indicator |

Adding a new `type` is backward-compatible: clients ignore unknown types.

| `user` | `{text}` | user bubble (history replay only; live runs render the user bubble inline in `send()`) |

The `user` event is emitted only by `GET /history/<id>` (below), not by a live `/design` run.

**Model selection (additive).** `/design` accepts an optional top-level `model` (a model id). The
shim validates it against an allowlist advertised by `/meta` (`{ models: [{id,label}], defaultModel }`);
an unknown/absent id falls back to the shim's `--model`/`SLIDEWRITE_MODEL` default, or the SDK's own
default when that's unset. The model the SDK actually runs is echoed back in the `start` event. The
extension renders the `/meta` list in a composer dropdown and persists the choice per-origin.

**Chat history (read-only).** `claude` writes one `.jsonl` transcript per session under
`~/.claude/projects/<encoded-cwd>/` (the cwd with every non-alphanumeric char turned into a single
`-`; matched case-insensitively against the directory listing). Two GET routes, behind the same
Bearer+CORS gate as `/meta`, expose the **current repo's** sessions:

- `GET /history` → `{ sessions: [{ id, title, firstPrompt, startedAt, endedAt, branch, messageCount }] }`,
  newest first. `title` is the session's `ai-title` if present, else its first user prompt. Missing
  project folder → `{ sessions: [] }`.
- `GET /history/<id>` → `{ id, events: [...] }`, where `events` reuses the §6 shapes above (plus the
  `user` event) so the panel replays a past session through the same renderer. `id` must be a valid
  session UUID (regex-validated + path-traversal-guarded); a bad/missing id → 404. Lifecycle events
  (`start`/`commit`/`done`) are not emitted for a replay.

**Resume (additive).** `/design` accepts an optional top-level `resume` (a session UUID). When
present and valid, the shim passes `resume` to the SDK `query` so the run continues that
conversation. The `busy` lock and the per-run auto-commit (diff of `git status` before/after) are
unaffected — only files changed by *this* run are committed. An absent/invalid value starts fresh.
The extension's 🕘 history view offers a **↻ Resume** action that threads subsequent sends into the
chosen session.

---

## 7. The element-capture contract

When the user clicks an element in Markup mode, the extension POSTs (plus a top-level `screen` =
current route/view):

```jsonc
{
  "tag": "button",
  "id": null,
  "className": "btn btn-primary",   // full class string
  "text": "New",                    // textContent, trimmed, ≤120 chars
  "domPath": "div.topbar > button.btn.btn-primary",  // nth-of-type chain, ≤5 ancestors, stops at first id
  "rect": { "x": 1180, "y": 16, "w": 64, "h": 32 }
}
```
Centralized, semantic class names usually pinpoint the source; for CSS-in-JS / hashed classes, lean
on `text` + `domPath` + `screen`, or add framework-fiber data ([§8.4](#84-the-widget--remaining-files)).

---

## 8. The browser extension (`extension/`)

Manifest V3. The UI is **injected** into the page via a content script, rendered into a **Shadow
DOM** so host and panel styles never collide.

### 8.1 `manifest.json`
```jsonc
{
  "manifest_version": 3,
  "name": "Slide Write",
  "version": "0.1.0",
  "permissions": ["storage", "scripting", "activeTab"],
  "host_permissions": ["http://localhost/*", "http://127.0.0.1/*", "https://localhost/*"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": [{
    "matches": ["http://localhost/*", "http://127.0.0.1/*", "https://localhost/*"],
    "js": ["content/inject.js"],
    "run_at": "document_idle"
  }]
}
```
`http://localhost/*` matches any port, so it covers every project's dev server and the forwarded
shim port. `inject.js` mounts the widget only if `chrome.storage` has an **enabled** entry for
`location.origin` — inert otherwise. (For the reverse-proxy fallback, add your public host here.)

### 8.2 `content/sse.js` — the SSE reader (verbatim; runs in the content script, not the SW)
⚠️ The stream lives in the **content script** because MV3 service workers are killed after ~30s
idle, mid-run. `EventSource` can't POST or set headers, so read the `fetch` body manually:
```js
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
```
`shimUrl` is the per-origin value from config, e.g. `http://localhost:4040`.

### 8.3 `content/picker.js` — the element picker (capture-phase)
1. **Listen on `window` in the capture phase** for `mousemove`/`click`. Capture-phase
   `preventDefault()` + `stopPropagation()` on click means marking an element **never triggers the
   app's own handlers**.
2. **`document.elementFromPoint`**, then walk up and **skip your own UI** — tag every node you
   render with `data-slidewrite-ui` and ignore hits inside one:
   ```js
   function skipOwnUI(el) {
     let n = el;
     while (n && n !== document.body && n !== document.documentElement) {
       if (n.dataset && "slidewriteUi" in n.dataset) return null;
       n = n.parentElement;
     }
     return (!el || el === document.body || el === document.documentElement) ? null : el;
   }
   ```
3. **Highlight box is `position:fixed; pointer-events:none`** at the target's `getBoundingClientRect()`.
4. **Capture the [§7](#7-the-element-capture-contract) context**, leave markup mode, open the composer
   anchored to the element. Build `domPath` as an `nth-of-type` chain of ≤5 ancestors, stopping at the first `id`.

### 8.4 The widget & remaining files
- **`content/panel.js`** — transcript + composer. Renders each [§6](#6-the-sse-event-contract) event
  as a row; **coalesce consecutive same-role streaming deltas** into one bubble; tool/result rows
  break the chain. Footer textarea (⌘/Ctrl+Enter), disabled while a run is in flight;
  `AbortController` cancels on close. The composer's toolbar row holds a model selector (populated
  from `/meta`, persisted per-origin) and the send button, modeled on the Claude AI chat composer.
  A 🕘 header button opens a **history view**: `GET /history` lists this repo's past sessions; picking
  one calls `GET /history/<id>` and **replays it read-only** through the same `onEvent` renderer (the
  live transcript is left intact). A **↻ Resume** action sets a resume chip and threads subsequent
  sends into that session via the `/design` `resume` field.
- **`content/sse.js`** — the SSE reader plus `fetchHistory`/`fetchHistoryDetail` JSON GET helpers.
- **`content/inject.js`** — create a host node + `attachShadow({mode:'open'})`, inject `styles.css`
  into the shadow root, mount the panel + a toolbar affordance, wire the shortcut. Look up config for
  `location.origin`; call `GET <shimUrl>/meta`; show "wired to `<project>` @ `<branch>`" in the header.
- **`background.js`** — owns `chrome.storage` config; serves get/set to options & popup. No network.
- **`options.html/js`** — per-origin rows: `{ origin, enabled, token, shimUrl }`.
- **`popup.html/js`** — toggle enable for the active tab's origin; show `/meta` confirmation.
- **`styles.css`** — scoped to the shadow root (`:host`, `.sw-*`).

**Extension-only superpower (roadmap):** because the content script runs *in the page*, it can read
the React fiber (`__reactFiber$…`) on the clicked node to recover the component name + `_debugSource`
(file:line) in dev builds, and send it alongside the DOM context — far more precise than
class/`domPath` grepping for CSS-in-JS / hashed-class projects. Optional, framework-specific.

---

## 9. Discovery & routing

Per origin, the options page stores `{ enabled, token, shimUrl }` — e.g.
`http://localhost:5173 → http://localhost:4040`. The shim and app run on different ports
(cross-origin), so `shimUrl` is explicit (not derivable). On load the content script looks up
`location.origin`; if enabled, it calls `GET <shimUrl>/meta` and shows **"wired to `<project>` @
`<branch>`"** so you can confirm the tab points at the repo you expect. Run several projects at once
— each shim on its own port, each origin mapped accordingly.

---

## 10. Security model

The shim runs **arbitrary code edits + shell** in a repo as you. Defenses:

- **Loopback bind.** The shim listens on `127.0.0.1` only — never a public interface. It's reachable
  from the browser solely through VS Code's port forward (authenticated by the VS Code remote
  connection) or directly on the same machine.
- **Bearer token.** Every route except `/health` requires `Authorization: Bearer <SLIDEWRITE_TOKEN>`;
  reject with 401 first. Use a random secret per project; never commit it.
- **CORS allowlist = anti-CSRF.** A JSON POST triggers a preflight; the shim only approves your app's
  origin, so a random site you browse can't drive the shim even though it's on localhost. Combined
  with the token, two independent gates.
- **Runs as you (non-root).** Edits are host-owned; `bypassPermissions` is allowed without root
  hacks. Optional hardening: a `canUseTool` deny-list (WebFetch/WebSearch, `git push`) to blunt
  prompt-injection exfiltration.
- **Prompt injection.** A malicious string in the repo could steer `claude`; the working-directory
  boundary (`cwd: REPO`) is the main mitigation. For higher assurance, run against a throwaway `git worktree`.
- **History is read-only and repo-scoped.** `/history*` only read `~/.claude/projects/<this repo>/`;
  the session `id` is UUID-validated and path-traversal-guarded before any file read, so the route
  can't be coerced into reading other projects or arbitrary files. Same Bearer+CORS gate as `/meta`.

Single-developer, trusted-local only. Not multi-tenant or public.

---

## 11. Quick start

**Prerequisites:** Claude Code installed and logged in (`claude` on PATH), Node 18+, VS Code.

**Per machine (once):**
```bash
cd shim && npm install        # pulls @anthropic-ai/claude-agent-sdk
```

**Per project:** run the shim pointed at the repo, on its own port:
```bash
node shim/slide-write.mjs --repo /path/to/project --port 4040 \
  --origin http://localhost:5173 --token "$(openssl rand -hex 16)"
```
Add `--debug` (or set `SW_DEBUG=1`) to log every SDK message (`type`/`subtype`) to stderr during a
run — useful for seeing the raw message sequence before it's translated into SSE events.
In **remote/WSL/container** dev, run this in a VS Code terminal on the code host — VS Code
auto-forwards port 4040 (and your dev server's port) to your laptop's `localhost`. Open the app via
its forwarded `localhost` URL.

**In the extension (once per project):** open options → add origin `http://localhost:5173`, set
`shimUrl http://localhost:4040` + the token, enable. Then open the app, click the toolbar button,
and design. To stop: kill the shim process.

---

## 12. Build order for Claude

Each phase is independently testable; build and verify in order.

1. **Shim.** Implement `shim/package.json` + `shim/slide-write.mjs` ([§5](#5-the-shim-shim)). Then:
   ```bash
   node shim/slide-write.mjs --repo "$PWD" --port 4040 --token test --origin http://localhost:5173 &
   curl -s localhost:4040/health
   curl -s -H 'Authorization: Bearer test' localhost:4040/meta
   curl -sN -X POST localhost:4040/design -H 'Authorization: Bearer test' \
     -H 'Content-Type: application/json' -d '{"prompt":"append a CSS comment to <some file>"}'
   ```
   Expect `start → file_edit → result → commit → done`, then one scoped commit
   (`git reset --hard HEAD~1` to clean up). Confirm SDK message shapes here.
2. **Extension — minimal.** `manifest.json`, `background.js`, `options.*`, `content/inject.js` +
   `content/sse.js` + `content/panel.js` (chat only, no picker). Drive a text-prompt change end to
   end from the browser; render the [§6](#6-the-sse-event-contract) events.
3. **Extension — picker.** `content/picker.js` ([§8.3](#83-contentpickerjs--the-element-picker-capture-phase));
   send the [§7](#7-the-element-capture-contract) contract; anchored composer; markup toggle.
4. **Polish.** Popup enable/disable, auto-reload-on-`commit` option, token UX, the [§10](#10-security-model) checklist.
5. **History & resume.** Add the `/history` + `/history/<id>` routes and the `resume` field
   ([§6](#6-the-sse-event-contract)) to the shim, then the 🕘 history view + ↻ Resume in the panel. Verify:
   ```bash
   curl -s -H 'Authorization: Bearer test' localhost:4040/history            # {sessions:[…]} newest-first
   curl -s -H 'Authorization: Bearer test' localhost:4040/history/<uuid>     # {id,events:[…]} (404 on bad id)
   curl -sN -X POST localhost:4040/design -H 'Authorization: Bearer test' \
     -H 'Content-Type: application/json' -d '{"prompt":"what did you just change?","resume":"<uuid>"}'
   ```
   Expect the resumed run to reference prior context and still commit only its own changes. In the UI:
   🕘 → pick a session → read-only replay → ↻ Resume → follow-up threads into that session.
6. **(Optional)** fiber-based element resolution ([§8.4](#84-the-widget--remaining-files)).

---

## 13. Fallback: public-hostname access via a reverse proxy

Use this **only** if you must open the app at a public hostname (e.g. `https://app.example.com`)
instead of a VS Code-forwarded `localhost` URL. A public-origin page calling `localhost` hits
cross-origin + Chrome's Private/Local Network Access checks, so instead mount the shim on the app's
**own hostname** under a path prefix, making the call same-origin.

With Traefik (Docker-label form), route `Host(app) && PathPrefix(/_slidewrite)` → StripPrefix →
the shim's port, at higher priority than the app's catch-all router. The extension then uses
`shimUrl = location.origin + "/_slidewrite"`. Bind the shim to the proxy network instead of pure
loopback, and keep the token + an `ipAllowList` middleware as the boundary. This is strictly more
setup than the default; prefer VS Code forwarding whenever you can.

---

## 14. Prior art

The *visual-edit → source* space is active — worth a scan before building:
- **Locator.js** — click a rendered element, jump to its component source (validates §8.4).
- **Onlook**, **Builder.io Visual Copilot** — visual editing that emits code changes.

The distinctive angle here: a **generic local shim driving your already-installed `claude` against
the real repo, surfaced in any app via a browser extension, reaching every dev topology through VS
Code's port forwarding** — no Docker, no proxy, no API key, zero frontend footprint.
