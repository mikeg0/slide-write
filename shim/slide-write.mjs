#!/usr/bin/env node
// slide-write — drive `claude` headless in a repo, stream the run as SSE on loopback.
// Reuses ~/.claude (no API key). Binds 127.0.0.1 only; reach it via VS Code port forwarding.
import http from "node:http";
import os from "node:os";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const PORT    = +(arg("port",   process.env.SLIDEWRITE_PORT   ?? 4040));
const REPO    = resolve(arg("repo", process.cwd()));
const TOKEN   = arg("token",  process.env.SLIDEWRITE_TOKEN ?? "");
const ORIGIN  = arg("origin", process.env.SLIDEWRITE_ALLOWED_ORIGIN ?? "*"); // app origin, e.g. http://localhost:5173
const DEBUG   = process.argv.includes("--debug") || !!process.env.SW_DEBUG;  // log each SDK message to stderr
// Opt-in: load the target repo's Agent Skills (.claude/skills/*/SKILL.md) so projects can define
// their own image-asset / design procedures. `settingSources:["project"]` alone does NOT enable
// skills — the `skills` query option does (and the SDK auto-adds the Skill tool when it's set).
const USE_SKILLS = process.argv.includes("--use-skills") || !!process.env.SLIDEWRITE_USE_SKILLS;
const VERSION = "0.1.0";

// Models the UI may pick from. Advertised via /meta so the client dropdown stays server-driven; a
// `/design` request's `model` is validated against this allowlist before reaching the SDK (an
// unknown id falls back to DEFAULT_MODEL, or the SDK's own default when that's unset). Keep ids in
// sync with the installed `claude` CLI / Agent SDK.
const MODELS = [
  { id: "claude-opus-4-8",           label: "Claude Opus 4.8" },
  { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];
const DEFAULT_MODEL = arg("model", process.env.SLIDEWRITE_MODEL ?? ""); // "" = let the SDK decide
const modelAllowed  = (m) => MODELS.some((x) => x.id === m);

// Gemini "nano banana" image generation. Model id is overridable so a rename doesn't need a code
// edit. The key is a shim-level fallback used only when a /generate-image request omits one (the
// extension normally sends it). IMAGE_INSTRUCTIONS is a fallback for the per-project integration
// steps (asset path, naming, DB write, resize) the request normally carries.
const GEMINI_MODEL = arg("gemini-model", process.env.SLIDEWRITE_GEMINI_MODEL ?? "gemini-2.5-flash-image");
const GEMINI_KEY   = arg("gemini-key",   process.env.GEMINI_API_KEY ?? "");
const IMAGE_INSTRUCTIONS = arg("image-instructions", process.env.SLIDEWRITE_IMAGE_INSTRUCTIONS ?? "");

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

// The §7 element-capture contract, serialized for the prompt. Single-sourced so buildPrompt and
// buildImagePrompt stay in sync. Returns null when there's nothing useful to send.
function elementContext(element) {
  if (!element) return null;
  const ctx = Object.fromEntries(Object.entries({
    tag: element.tag, id: element.id, class: element.className,
    text: element.text, domPath: element.domPath, rect: element.rect,
  }).filter(([, v]) => v));
  return Object.keys(ctx).length ? ctx : null;
}

function buildPrompt({ prompt = "", screen, element }) {
  const parts = [String(prompt).trim()];
  if (screen) parts.push(`\n[Current screen: ${screen}]`);
  const ctx = elementContext(element);
  if (ctx)
    parts.push("\n[The user clicked this on-screen element and is referring to it]\n" +
      JSON.stringify(ctx, null, 2) +
      "\nUse the class names / text / DOM path to locate the source and matching styles, then edit there.");
  return parts.join("\n");
}

// Prompt for an image run: the image already exists on disk at `tmpPath` (outside the repo). Tell
// claude to place it per the project's conventions and wire it into the picked element. Stays
// generic — framework specifics live in the target repo's CLAUDE.md. The per-project
// `imageInstructions` (exact path, naming, DB write, resize…) are appended last and take precedence.
function buildImagePrompt({ imagePrompt = "", screen, element, imageInstructions }, tmpPath, hasSource) {
  const parts = [
    (hasSource
      ? "A newly edited version of the selected image has been generated and saved on disk at:"
      : "A new image has been generated and saved on disk at:") +
    `\n  ${tmpPath}\n(this file is OUTSIDE the repo). Then:\n` +
    "1. If this project defines an image-asset Skill or documents image conventions in its CLAUDE.md / " +
    "README (save path, naming, resizing, database/CDN steps), FOLLOW THAT. Otherwise copy the file into " +
    "the project's conventional static-assets location (the framework-appropriate public/static dir, or " +
    "an imported asset) with a descriptive filename.\n" +
    "2. Wire it into the on-screen element the user selected: set the <img>'s src, or the element's CSS " +
    "background-image, matching the existing patterns in the source.\n\n" +
    `Original image request: ${String(imagePrompt).trim()}`,
  ];
  if (screen) parts.push(`\n[Current screen: ${screen}]`);
  const ctx = elementContext(element);
  if (ctx)
    parts.push("\n[The user selected this on-screen element — place the image here]\n" +
      JSON.stringify(ctx, null, 2) +
      "\nUse the class names / text / DOM path to locate the source, then edit there.");
  const extra = (imageInstructions || "").trim();
  if (extra)
    parts.push("\n[Project-specific integration steps — follow these exactly; they take precedence over the above]\n" + extra);
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
// Strip the repo prefix for display, tolerating slash-direction and drive-letter-case differences
// between REPO and the path the SDK/transcript recorded (Windows reports `c:\…`, resolve gives `C:\…`).
const relPath = (p) => {
  if (!p) return "";
  const np = p.replace(/\\/g, "/"), nr = REPO.replace(/\\/g, "/");
  return np.toLowerCase().startsWith(nr.toLowerCase()) ? np.slice(nr.length).replace(/^\//, "") : p;
};

// --- Chat history (read-only) ----------------------------------------------------------------
// `claude` writes one .jsonl transcript per session under ~/.claude/projects/<encoded-cwd>/.
// The folder name is the cwd with every non-alphanumeric char turned into a single "-". Drive-letter
// case can differ from REPO on Windows, so match the folder case-insensitively against the listing.
let _projDir;
async function claudeProjectDir() {
  if (_projDir) return _projDir;
  const encoded = REPO.replace(/[^a-zA-Z0-9]/g, "-");
  const base = join(os.homedir(), ".claude", "projects");
  try {
    const entries = await readdir(base, { withFileTypes: true });
    const hit = entries.find(e => e.isDirectory() && e.name.toLowerCase() === encoded.toLowerCase());
    if (hit) return (_projDir = join(base, hit.name));
  } catch { /* ~/.claude/projects missing */ }
  return null;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const validSessionId = (id) => typeof id === "string" && UUID_RE.test(id);

// Pull the text out of a user message's content (array of blocks, or a bare string).
const userText = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const t = content.filter(b => b?.type === "text").map(b => b.text).join("\n").trim();
    return t || (content.some(b => b?.type === "image") ? "[image]" : "");
  }
  return "";
};

// List this repo's sessions, newest first. One pass per .jsonl file extracts a summary.
async function listHistory() {
  const dir = await claudeProjectDir();
  if (!dir) return [];
  let files;
  try { files = (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith(".jsonl")); }
  catch { return []; }
  const sessions = [];
  for (const f of files) {
    try {
      const lines = (await readFile(join(dir, f.name), "utf8")).split("\n").filter(Boolean);
      let title = "", firstPrompt = "", startedAt = "", endedAt = "", branch = "", messageCount = 0;
      for (const line of lines) {
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.timestamp) { startedAt ||= rec.timestamp; endedAt = rec.timestamp; }
        if (rec.gitBranch && !branch) branch = rec.gitBranch;
        if (rec.type === "ai-title" && rec.aiTitle) title = rec.aiTitle;
        else if (rec.type === "user" && rec.message) {
          const t = userText(rec.message.content);
          if (t && !t.startsWith("[image]")) { firstPrompt ||= t; }
          messageCount++;
        } else if (rec.type === "assistant") messageCount++;
      }
      if (!title) title = (firstPrompt || "(untitled)").slice(0, 80);
      sessions.push({
        id: f.name.slice(0, -".jsonl".length), title,
        firstPrompt: firstPrompt.slice(0, 140), startedAt, endedAt, branch, messageCount,
      });
    } catch { /* skip unreadable transcript */ }
  }
  sessions.sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
  return sessions;
}

// Parse one transcript into render-ready events mirroring the §6 SSE shapes (plus a `user` event), so
// the panel replays it through the same onEvent renderer. Returns null for a bad/missing id.
async function readHistory(id) {
  if (!validSessionId(id)) return null;
  const dir = await claudeProjectDir();
  if (!dir) return null;
  const file = resolve(dir, `${id}.jsonl`);
  if (!file.startsWith(dir + sep)) return null; // belt-and-suspenders traversal guard (id is already UUID-validated)
  let lines;
  try { lines = (await readFile(file, "utf8")).split("\n").filter(Boolean); }
  catch { return null; }
  const tool = {}, events = [];
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const content = rec.message?.content;
    if (rec.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text" && b.text) events.push({ type: "delta", text: b.text });
        else if (b.type === "thinking" && b.thinking) events.push({ type: "thinking_delta", text: b.thinking });
        else if (b.type === "tool_use") {
          tool[b.id] = b.name;
          if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(b.name))
            events.push({ type: "file_edit", tool: b.name, path: relPath(b.input?.file_path || ""), id: b.id });
          else events.push({ type: "tool", tool: b.name, detail: detailOf(b.name, b.input), id: b.id });
        }
      }
    } else if (rec.type === "user") {
      const blocks = Array.isArray(content) ? content : [{ type: "text", text: userText(content) }];
      const results = blocks.filter(b => b?.type === "tool_result");
      if (results.length) for (const b of results) {
        const { text, trunc } = resultText(b.content);
        events.push({ type: "tool_result", tool: tool[b.tool_use_id], id: b.tool_use_id, text, isError: !!b.is_error, truncated: trunc });
      } else {
        const t = userText(content);
        if (t) events.push({ type: "user", text: t });
      }
    } else if (rec.type === "result") {
      events.push({ type: "result", isError: !!rec.is_error, numTurns: rec.num_turns,
        durationMs: rec.duration_ms, totalCostUsd: rec.total_cost_usd, usage: rec.usage, result: null });
    }
  }
  return { id, events };
}

// Generate (or edit) an image with Gemini "nano banana" via the Generative Language REST API.
// Generic — knows nothing about the target repo. The key goes in a header (never the URL, so it
// can't leak into request logs); `image` (optional, {mimeType,data}) makes it image-to-image.
// Returns decoded bytes + mime, or throws a clean, key-free Error.
async function generateImage({ prompt, key, image, signal }) {
  const parts = [];
  if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  parts.push({ text: prompt });
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
    { method: "POST", signal,
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }) },
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = JSON.parse(await res.text())?.error?.message || msg; } catch { /* non-JSON body */ }
    throw new Error(`Gemini ${res.status}: ${msg}`);
  }
  const data = await res.json();
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
  const cand = data.candidates?.[0];
  for (const p of cand?.content?.parts ?? []) {
    const inl = p.inlineData || p.inline_data;            // v1beta JSON returns camelCase; accept both
    if (inl?.data) return { bytes: Buffer.from(inl.data, "base64"), mimeType: inl.mimeType || inl.mime_type || "image/png" };
  }
  const why = cand?.finishReason && cand.finishReason !== "STOP" ? ` (finishReason: ${cand.finishReason})` : "";
  throw new Error(`Gemini returned no image${why}`);
}

// Drive one `claude` query, streaming the §6 SSE events. Returns whether the run errored. Shared by
// runDesign and runImage so the event contract lives in one place.
async function streamQuery(prompt, body, emit, aborted) {
  const tool = {}; let streamedText = false, hadError = false;
  // Resolve the requested model against the allowlist; fall back to DEFAULT_MODEL (or, if that's
  // unset, omit `model` entirely so the SDK uses its own default). The actual model the SDK runs is
  // echoed back to the client in the `start` event from system/init.
  const model = modelAllowed(body.model) ? body.model : (DEFAULT_MODEL || undefined);
  for await (const m of query({ prompt, options: {
    cwd: REPO, permissionMode: "bypassPermissions",  // runs as you (non-root) → allowed, no callback
    allowDangerouslySkipPermissions: true,           // required by the SDK alongside bypassPermissions
    includePartialMessages: true, settingSources: ["project"], systemPrompt: PREAMBLE, maxTurns: 40,
    ...(USE_SKILLS ? { skills: "all" } : {}),                         // load the target repo's project skills
    ...(model ? { model } : {}),
    ...(validSessionId(body.resume) ? { resume: body.resume } : {}),  // continue a prior session if asked
  } })) {
    if (aborted()) return hadError;
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
        emit("file_edit", { tool: b.name, path: relPath(b.input?.file_path || ""), id: b.id });
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
  return hadError;
}

// Commit only what THIS run changed (diff of porcelain before/after); no push.
async function commitChanged(dirty0, subj, emit) {
  const changed = (await porcelainPaths()).filter(p => !dirty0.has(p));
  if (!changed.length) return;
  await git("add", "--", ...changed);
  await git("-c", "user.name=Slide Write", "-c", "user.email=slide-write@local", "commit", "-m", `slide-write: ${subj}`);
  emit("commit", { sha: await git("rev-parse", "--short", "HEAD"), count: changed.length });
}

// Core: drive one design run. `emit(type, data)` sends an SSE event; `aborted()` lets the caller
// cancel (client disconnect). Exported so the HTTP handler and tests share one implementation.
export async function runDesign(body, emit, aborted = () => false) {
  const dirty0 = new Set(await porcelainPaths());
  const hadError = await streamQuery(buildPrompt(body), body, emit, aborted);
  if (aborted()) return;
  if (!hadError) await commitChanged(dirty0, (body.prompt || "design change").split("\n")[0].slice(0, 72), emit);
  emit("done");
}

// Image run: generate the image with Gemini, save it to a temp file OUTSIDE the repo, then drive
// `claude` to place it and wire it into the picked element. The fourth arg is an AbortSignal so the
// (potentially slow) Gemini fetch is cancelled on client disconnect, not just the polled SDK loop.
export async function runImage(body, emit, aborted = () => false, signal) {
  const key = body.geminiKey || GEMINI_KEY;
  if (!key) { emit("error", { message: "no Gemini API key — set one in the extension options" }); return emit("done"); }
  emit("image_status", { state: "generating" });
  // Optional source image for image-to-image (the user picked an <img>): data:<mime>;base64,<data>.
  let image;
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(body.element?.imageDataUrl || "");
  if (m) image = { mimeType: m[1], data: m[2] };
  const { bytes, mimeType } = await generateImage({ prompt: body.imagePrompt || "", key, image, signal });
  if (aborted()) return;
  const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  const tmpPath = join(os.tmpdir(), `slidewrite-${Date.now()}.${ext}`);
  await writeFile(tmpPath, bytes);
  emit("image_generated", { tmpPath, mimeType, bytes: bytes.length });  // metadata only — no base64 over the wire
  if (aborted()) return;
  const dirty0 = new Set(await porcelainPaths());
  const prompt = buildImagePrompt({ ...body, imageInstructions: body.imageInstructions || IMAGE_INSTRUCTIONS }, tmpPath, !!image);
  const hadError = await streamQuery(prompt, body, emit, aborted);
  if (aborted()) return;
  if (!hadError) await commitChanged(dirty0, `add image — ${(body.imagePrompt || "add image").split("\n")[0].slice(0, 72)}`, emit);
  emit("done");
}

// Generic SSE wrapper: enforce the busy lock, set stream headers, parse the body, run `runner`, and
// always res.end(). An AbortController is tied to an early client disconnect so an in-flight fetch
// (Gemini) is cancelled too; the polled `aborted()` continues to guard the SDK loop.
async function streamRun(req, res, runner) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
  if (busy) { sse(res, "error", { message: "a run is already in progress" }); sse(res, "done"); return res.end(); }
  busy = true;
  // Abort only on a genuine client disconnect. NB: `req.destroyed` is true the moment the POST
  // body is fully read (Node tears down the request's readable side), so it can't signal
  // disconnect — using it aborts every run on the first SDK message. Watch the *response* for an
  // early `close` (before we've called res.end()) instead.
  let clientGone = false;
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) { clientGone = true; ac.abort(); } });
  try {
    const body = JSON.parse((await readBody(req)) || "{}");
    await runner(body, (t, d) => sse(res, t, d), () => clientGone, ac.signal);
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
        models: MODELS, defaultModel: DEFAULT_MODEL || MODELS[0].id,
        geminiModel: GEMINI_MODEL, geminiEnv: !!GEMINI_KEY,  // geminiEnv: shim has a server-side key fallback
      });
    if (path === "/history" && req.method === "GET")
      return json(res, 200, { sessions: await listHistory() });
    if (path.startsWith("/history/") && req.method === "GET") {
      const id = decodeURIComponent(path.slice("/history/".length));
      const data = await readHistory(id);
      return data ? json(res, 200, data) : json(res, 404, { error: "not found" });
    }
    if (path === "/design" && req.method === "POST") return streamRun(req, res, runDesign);
    if (path === "/generate-image" && req.method === "POST") return streamRun(req, res, runImage);
    json(res, 404, { error: "not found" });
  }).listen(PORT, "127.0.0.1", () =>
    console.error(`slide-write → http://127.0.0.1:${PORT}  repo=${REPO}  origin=${ORIGIN}`));
}

// Start the server only when run directly (so tests can import runDesign without listening).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
