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
    if (process.env.SW_DEBUG) console.error("SDK", m.type, m.subtype ?? "");
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
  // Abort only on a genuine client disconnect. NB: `req.destroyed` is true the moment the POST
  // body is fully read (Node tears down the request's readable side), so it can't signal
  // disconnect — using it aborts every run on the first SDK message. Watch the *response* for an
  // early `close` (before we've called res.end()) instead.
  let clientGone = false;
  res.on("close", () => { if (!res.writableEnded) clientGone = true; });
  try {
    const body = JSON.parse((await readBody(req)) || "{}");
    await runDesign(body, (t, d) => sse(res, t, d), () => clientGone);
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
    if (path === "/design" && req.method === "POST") return design(req, res);
    json(res, 404, { error: "not found" });
  }).listen(PORT, "127.0.0.1", () =>
    console.error(`slide-write → http://127.0.0.1:${PORT}  repo=${REPO}  origin=${ORIGIN}`));
}

// Start the server only when run directly (so tests can import runDesign without listening).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
