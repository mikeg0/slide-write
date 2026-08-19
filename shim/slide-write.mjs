#!/usr/bin/env node
// slide-write — drive `claude` headless in a repo, stream the run as SSE on loopback.
// Reuses ~/.claude (no API key). Binds 127.0.0.1 by default; reach it via VS Code port forwarding.
// `--bind <addr>` overrides for the §13 reverse-proxy fallback (e.g. the docker bridge gateway).
import http from "node:http";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const PORT    = +(arg("port",   process.env.SLIDEWRITE_PORT   ?? 4040));
const REPO    = resolve(arg("repo", process.cwd()));
const TOKEN   = arg("token",  process.env.SLIDEWRITE_TOKEN ?? "");
const ORIGIN  = arg("origin", process.env.SLIDEWRITE_ALLOWED_ORIGIN ?? "*"); // app origin, e.g. http://localhost:5173
const BIND    = arg("bind",   process.env.SLIDEWRITE_BIND ?? "127.0.0.1");   // §13 fallback only — keep loopback otherwise
// Multi-host mode (§13 generic proxy route): serve MANY repos from one shim, resolving the target
// repo per request from the Host header. `--repos host=path,…` maps hosts explicitly; `--repo-root`
// auto-maps a host's first DNS label to a directory under it (life-ops.dev.x.com → <root>/life-ops).
// When neither is given the shim is single-repo and ignores Host entirely (original behavior).
const REPO_ROOT = arg("repo-root", process.env.SLIDEWRITE_REPO_ROOT ?? "");
const REPO_MAP  = new Map((arg("repos", process.env.SLIDEWRITE_REPOS ?? "") || "")
  .split(",").filter(s => s.includes("=")).map((s) => {
    const i = s.indexOf("=");
    return [s.slice(0, i).trim().toLowerCase(), resolve(s.slice(i + 1).trim())];
  }));
const MULTI_HOST = !!(REPO_ROOT || REPO_MAP.size);
const DEBUG   = process.argv.includes("--debug") || !!process.env.SW_DEBUG;  // log each SDK message to stderr
// Opt-in: load the target repo's Agent Skills (.claude/skills/*/SKILL.md) so projects can define
// their own image-asset / design procedures. `settingSources:["project"]` alone does NOT enable
// skills — the `skills` query option does (and the SDK auto-adds the Skill tool when it's set).
const USE_SKILLS = process.argv.includes("--use-skills") || !!process.env.SLIDEWRITE_USE_SKILLS;
const VERSION = "0.1.0";

const DEFAULT_MODEL = arg("model", process.env.SLIDEWRITE_MODEL ?? ""); // "" = let the SDK decide
const effortLabel = (id) => id === "xhigh" ? "Extra high" : id.charAt(0).toUpperCase() + id.slice(1);
const requestedModel = (body) => typeof body.model === "string" && body.model.trim()
  ? body.model.trim() : undefined;
const selectedEffort = (body) => typeof body.effort === "string"
  && body.effort !== "default" && /^[a-z][a-z0-9_-]{0,31}$/.test(body.effort) ? body.effort : undefined;

// --- Provider selection (Anthropic / OpenAI / Grok / Google) --------------------------------
// Anthropic is the default path (the claude Agent SDK above). OpenAI is driven by the `codex` CLI
// (`codex exec --json`) — the agentic parallel to claude — which natively authenticates from
// CODEX_HOME/auth.json (ChatGPT oauth). Grok (xAI) is driven by the host `grok` CLI headless
// (`streaming-messages-json`), reusing `~/.grok` login or inherited `XAI_API_KEY`. Google is a
// not-yet-wired placeholder advertised as disabled.
const CODEX_BIN  = arg("codex-bin",  process.env.SLIDEWRITE_CODEX_BIN  ?? "codex"); // `codex` on PATH, or a full path
const CODEX_HOME = arg("codex-home", process.env.SLIDEWRITE_CODEX_HOME ?? "");       // "" → codex's own default (~/.codex)
const codexHome  = () => CODEX_HOME || join(os.homedir(), ".codex");
const CODEX_VERSION_FALLBACK = "0.144.1"; // used only if `codex --version` can't be parsed
const GROK_BIN  = arg("grok-bin",  process.env.SLIDEWRITE_GROK_BIN  ?? "grok"); // `grok` on PATH, or a full path
const GROK_HOME = arg("grok-home", process.env.SLIDEWRITE_GROK_HOME ?? "");       // "" → grok's own default (~/.grok)
const grokHome  = () => GROK_HOME || join(os.homedir(), ".grok");
// Live stream: Grok edit tools (≠ Claude EDIT_TOOLS). Path field is always `file_path`.
// Frozen against grok CLI 1.0.3 — see shim/fixtures/grok-streaming-messages-edit.jsonl.
const GROK_EDIT_TOOLS = ["search_replace", "write"];
let _codexVer;
function codexClientVersion() {                                  // the /models endpoint requires client_version
  if (_codexVer) return _codexVer;
  _codexVer = new Promise((r) => execFile(CODEX_BIN, ["--version"], (_e, out) => {
    const m = /(\d+\.\d+\.\d+)/.exec(out || "");
    r(m ? m[1] : CODEX_VERSION_FALLBACK);
  }));
  return _codexVer;
}

// Every discovery helper below returns `{ models, error?, fix? }` and never throws. `error` is a
// human-readable reason the list came back empty — the panel shows it verbatim instead of a generic
// "no models" hint (README §"Dynamic model lists") — and `fix` is the single shell command that
// repairs it. Absent keys mean "nothing to report"; an empty list with no `error` is a real answer
// (e.g. an account with no entitlements), not a failure.
//
// Ask the authenticated Claude Code subprocess for the models available to this repo/account. An
// empty async input stream lets the SDK complete its initialization handshake without a model turn.
async function anthropicModels(repo) {
  async function* emptyPrompt() {}
  let q;
  try {
    q = query({ prompt: emptyPrompt(), options: { cwd: repo, settingSources: ["project"] } });
    // Bound the handshake (parity with the Python shim's 20s subprocess timeout) so a stuck
    // subprocess can't hang /meta; the finally close() reaps it either way.
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("model discovery timed out")), 20_000).unref());
    const models = (await Promise.race([q.supportedModels(), timeout]))
      .filter((m) => typeof m.value === "string" && m.value)
      .map((m) => {
        const levels = (m.supportedEffortLevels || []).filter((id) => typeof id === "string" && id);
        return {
          id: m.value,
          label: m.displayName || m.value,
          description: m.description || "",
          efforts: levels.length ? [
            { id: "default", label: "Default", description: "Use Claude Code's configured effort" },
            ...levels.map((id) => ({ id, label: effortLabel(id), description: "" })),
          ] : [],
          defaultEffort: levels.length ? "default" : "",
        };
      });
    return { models };
  } catch (e) {
    const msg = e?.message || String(e);
    if (DEBUG) console.error("anthropicModels:", msg);
    return { models: [], error: `claude model discovery failed: ${msg}`, fix: "claude auth login" };
  } finally { q?.close(); }
}

// Fetch the OpenAI model list the way codex does: the ChatGPT-account-scoped /models endpoint, using
// the oauth access_token from CODEX_HOME/auth.json. (api.openai.com/v1/models 403s with this token —
// this is the only working source.) Returns model/effort metadata for the *listable*,
// api-supported models. Called when the panel opens; any failure → an empty list plus the `error`
// (and, when a re-login is the cure, the `fix`) the panel shows in place of the model dropdown.
async function openAiModels() {
  const authPath = join(codexHome(), "auth.json");
  let auth;
  try {
    auth = JSON.parse(await readFile(authPath, "utf8"));
  } catch (e) {
    if (DEBUG) console.error("openAiModels:", e?.message || e);
    return { models: [], fix: "codex login",
      error: e?.code === "ENOENT" ? `codex is not signed in — no ${authPath}`
                                  : `can't read ${authPath}: ${e?.message || e}` };
  }
  const token = auth?.tokens?.access_token, account = auth?.tokens?.account_id;
  if (!token) return { models: [], error: `no ChatGPT access token in ${authPath}`, fix: "codex login" };
  try {
    const ver = await codexClientVersion();
    const res = await fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(ver)}`,
      { signal: AbortSignal.timeout(15_000),   // parity with the Python shim's urlopen timeout
        headers: { authorization: `Bearer ${token}`, "chatgpt-account-id": account || "",
                   originator: "codex_cli_rs", "user-agent": "codex_cli_rs" } });
    if (!res.ok) {
      if (DEBUG) console.error("openAiModels: HTTP", res.status);
      // 401 here is terminal, not transient: codex silently rotates this token in normal use, so a
      // 401 reaching the shim means the refresh token is spent/revoked too — only a re-login fixes
      // it, and `codex exec` is just as broken. Say so rather than showing an empty dropdown.
      return res.status === 401
        ? { models: [], fix: "codex logout && codex login",
            error: "codex sign-in expired or revoked (HTTP 401 from the ChatGPT models endpoint)" }
        : { models: [], error: `ChatGPT models endpoint returned HTTP ${res.status}` };
    }
    const data = await res.json();
    const models = (data.models || [])
      .filter((m) => m.slug && m.visibility === "list" && m.supported_in_api !== false)
      .map((m) => ({
        id: m.slug,
        label: m.display_name || m.slug,
        efforts: (m.supported_reasoning_levels || [])
          .filter((level) => typeof level.effort === "string" && level.effort)
          .map((level) => ({
            id: level.effort,
            label: effortLabel(level.effort),
            description: level.description || "",
          })),
        defaultEffort: m.default_reasoning_level || "",
      }));
    return { models };
  } catch (e) {
    if (DEBUG) console.error("openAiModels:", e?.message || e);
    return { models: [], error: `couldn't reach the ChatGPT models endpoint: ${e?.message || e}` };
  }
}

// Grok model list: prefer a short `grok models` refresh (populates cache/login path), then read
// `$GROK_HOME/models_cache.json`. Any failure → an empty list plus an `error` naming the cause
// (missing CLI vs. no cache = not logged in), never a throw.
async function grokModels() {
  const env = { ...process.env };
  if (GROK_HOME) env.GROK_HOME = GROK_HOME;
  let spawnErr;   // kept so a missing `grok` binary reports itself instead of looking like a logout
  try {
    await new Promise((resolveDone) => {
      const child = spawn(GROK_BIN, ["models"], { env, stdio: ["ignore", "pipe", "pipe"] });
      const t = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} resolveDone(); }, 15_000);
      t.unref();
      child.on("close", () => { clearTimeout(t); resolveDone(); });
      child.on("error", (e) => { spawnErr = e; clearTimeout(t); resolveDone(); });
    });
  } catch (e) { spawnErr = e; if (DEBUG) console.error("grokModels spawn:", e?.message || e); }
  const cachePath = join(grokHome(), "models_cache.json");
  try {
    const raw = JSON.parse(await readFile(cachePath, "utf8"));
    const entries = raw?.models && typeof raw.models === "object" ? Object.values(raw.models) : [];
    const models = entries.map((entry) => {
      const info = entry?.info || entry || {};
      const id = info.id || info.model;
      if (typeof id !== "string" || !id) return null;
      const efforts = (info.reasoning_efforts || [])
        .filter((e) => e && (typeof e.id === "string" || typeof e.value === "string"))
        .map((e) => {
          const eid = e.id || e.value;
          return { id: eid, label: e.label || effortLabel(eid), description: e.description || "" };
        });
      const defaultEffort = (info.reasoning_efforts || []).find((e) => e?.default)?.id
        || (info.reasoning_efforts || []).find((e) => e?.default)?.value
        || info.reasoning_effort || "";
      return {
        id,
        label: info.name || id,
        description: info.description || "",
        efforts,
        defaultEffort: efforts.some((e) => e.id === defaultEffort) ? defaultEffort : (efforts[0]?.id || ""),
      };
    }).filter(Boolean);
    return models.length ? { models }
      : { models: [], error: `${cachePath} lists no models`, fix: "grok login" };
  } catch (e) {
    if (DEBUG) console.error("grokModels cache:", e?.message || e);
    if (spawnErr?.code === "ENOENT")
      return { models: [], error: `grok CLI not found at "${GROK_BIN}" — install it or pass --grok-bin <path>` };
    return { models: [], fix: "grok login",
      error: e?.code === "ENOENT" ? `grok is not signed in — no ${cachePath}`
                                  : `can't read ${cachePath}: ${e?.message || e}` };
  }
}

// Provider list for /meta — the client picks a provider on the options page, then the dropdown shows
// that provider's `models`. `enabled:false` advertises a provider the UI should show but not allow.
async function providerMeta(repo) {
  const [anthropic, openai, grok] = await Promise.all([anthropicModels(repo), openAiModels(), grokModels()]);
  const anthropicDefault = (DEFAULT_MODEL && anthropic.models.some((m) => m.id === DEFAULT_MODEL) && DEFAULT_MODEL)
    || anthropic.models[0]?.id || "";
  // `error`/`fix` are omitted when absent so the payload of a healthy provider is byte-identical to
  // what older extensions already parse (they ignore unknown keys either way).
  const entry = (id, label, disc, defaultModel) => ({
    id, label, enabled: true, models: disc.models, defaultModel,
    ...(disc.error ? { error: disc.error } : {}),
    ...(disc.fix ? { fix: disc.fix } : {}),
  });
  return {
    models: anthropic.models,
    defaultModel: anthropicDefault,
    providers: [
      entry("anthropic", "Anthropic", anthropic, anthropicDefault),
      entry("openai", "OpenAI", openai, openai.models[0]?.id || ""),
      entry("grok", "xAI", grok, grok.models[0]?.id || ""),
      { id: "google", label: "Google", enabled: false, models: [], defaultModel: "" },
    ],
    defaultProvider: "anthropic",
  };
}

// Gemini "nano banana" image generation. Model id is overridable so a rename doesn't need a code
// edit. The key is a shim-level fallback used only when a /generate-image request omits one (the
// extension normally sends it). IMAGE_INSTRUCTIONS is a fallback for the per-project integration
// steps (asset path, naming, DB write, resize) the request normally carries.
const GEMINI_MODEL = arg("gemini-model", process.env.SLIDEWRITE_GEMINI_MODEL ?? "gemini-2.5-flash-image");
const GEMINI_KEY   = arg("gemini-key",   process.env.GEMINI_API_KEY ?? "");
const IMAGE_INSTRUCTIONS = arg("image-instructions", process.env.SLIDEWRITE_IMAGE_INSTRUCTIONS ?? "");

// The generic system prompt prepended to every run — what makes this shim behave well against any
// repo (per-project knowledge comes from the target's own CLAUDE.md). README §"system prompt" mirrors
// this in human-readable prose; keep the two in sync, and mirror edits in shim/slide-write.py.
const PREAMBLE =
  "You are editing a web app live from within its running dev environment. Your edits land on the " +
  "repo at the working directory and the app's own dev server hot-reloads, so changes appear in the " +
  "browser within seconds.\n\n" +
  "FIRST, read the repo's CLAUDE.md / AGENTS.md (and README) for THIS project's conventions — where styling " +
  "lives, where components/screens live, the framework in use. Follow them.\n\n" +
  "- Make the SMALLEST focused change that satisfies the request, in the spirit of the existing code.\n" +
  "- Reuse existing tokens/components/patterns; don't add dependencies unless asked.\n" +
  "- Do NOT edit Dockerfiles, CI, or anything under .claude / .env / credentials.\n" +
  "- Keep schema/model changes ADDITIVE; never rename, drop, or retype an existing table or column.\n" +
  "- When done, reply with one or two sentences describing exactly what you changed.";

const git = (repo, ...a) => new Promise(r => execFile("git", ["-C", repo, ...a], (_e, out) => r((out || "").trim())));
// NB: parse porcelain UNtrimmed — `" M file"` starts with a space the status column needs.
const porcelainPaths = (repo) => new Promise(r => execFile("git", ["-C", repo, "status", "--porcelain", "-uall"],
  (_e, out) => r((out || "").split("\n").filter(Boolean).map(l => l.slice(3)))));

// Resolve the repo a request targets. Single-repo mode always answers REPO. Multi-host mode:
// explicit --repos entry → localhost fallback to --repo → first-DNS-label lookup under
// --repo-root (label sanitized: a Host header is attacker-controlled text, never a path).
// Returns null when nothing maps — the caller 404s.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
async function repoFor(req) {
  if (!MULTI_HOST) return REPO;
  const hostname = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  if (REPO_MAP.has(hostname)) return REPO_MAP.get(hostname);
  if (LOCAL_HOSTNAMES.has(hostname)) return REPO;
  const label = hostname.split(".")[0];
  if (REPO_ROOT && /^[a-z0-9-]+$/.test(label)) {
    const dir = join(resolve(REPO_ROOT), label);
    try { if ((await stat(dir)).isDirectory()) return dir; } catch { /* no such repo */ }
  }
  return null;
}
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

const busyRepos = new Set(); // one run at a time PER REPO; different repos may run concurrently

// The §7 element-capture contract, serialized for the prompt. Single-sourced so buildPrompt and
// buildImagePrompt stay in sync. Returns null when there's nothing useful to send.
function elementContext(element) {
  if (!element) return null;
  const ctx = Object.fromEntries(Object.entries({
    tag: element.tag, id: element.id, class: element.className,
    text: element.text, domPath: element.domPath, rect: element.rect,
    matchedStyles: element.matchedStyles,   // §7: authored CSS rules + source/line (CDP picker only)
  }).filter(([, v]) => v));
  return Object.keys(ctx).length ? ctx : null;
}

// Normalize a request's element targets: the §7 `elements` array (the composer stacks up to
// MAX_ELEMENTS picks), with the legacy single `element` still accepted. Capped server-side too, so
// an oversized payload can't balloon the prompt/context window.
const MAX_ELEMENTS = 5;
const elementsOf = (body) =>
  (Array.isArray(body.elements) ? body.elements : body.element ? [body.element] : [])
    .filter(Boolean).slice(0, MAX_ELEMENTS);

function buildPrompt({ prompt = "", screen }, elements = [], shotPaths = []) {
  const parts = [String(prompt).trim()];
  if (screen) parts.push(`\n[Current screen: ${screen}]`);
  const nth = (i) => (elements.length > 1 ? ` (element ${i + 1} of ${elements.length})` : "");
  elements.forEach((element, i) => {
    const ctx = elementContext(element);
    if (ctx)
      parts.push(`\n[The user clicked this on-screen element${nth(i)} and is referring to it]\n` +
        JSON.stringify(ctx, null, 2) +
        "\nUse the class names / text / DOM path to locate the source. When `matchedStyles` is present, " +
        "each rule's `source`+`line` is the authored origin of those styles — prefer editing there " +
        "(`source` is a dev-server URL; strip the origin/query to map it to a repo path).");
    if (shotPaths[i]) {
      // Pasted clipboard image (no DOM ctx): neutral wording — claude decides from the request
      // whether it's a visual reference or an asset to place. Picked-element screenshots keep the
      // "how it currently looks" framing.
      parts.push(element && element.pasted
        ? `\n[The user pasted this image${nth(i)}. It was saved at:\n  ${shotPaths[i]}\n(this file is OUTSIDE the repo). Read it. Depending on the request, use it as a visual reference for your edits, or — if they want it placed in the app — copy it into the project's assets and wire it in.]`
        : `\n[A screenshot of the selected element${nth(i)} was saved at:\n  ${shotPaths[i]}\n(this file is OUTSIDE the repo). Read it to see how the element currently looks before editing.]`);
    }
  });
  return parts.join("\n");
}

// Prompt for an image run: the image already exists on disk at `tmpPath` (outside the repo). Tell
// claude to place it per the project's conventions and wire it into the picked element. Stays
// generic — framework specifics live in the target repo's CLAUDE.md. The per-project
// `imageInstructions` (exact path, naming, DB write, resize…) are appended last and take precedence.
function buildImagePrompt({ imagePrompt = "", screen, imageInstructions }, elements, tmpPath, hasSource) {
  const parts = [
    (hasSource
      ? "A newly edited version of the selected image has been generated and saved on disk at:"
      : "A new image has been generated and saved on disk at:") +
    `\n  ${tmpPath}\n(this file is OUTSIDE the repo). Then:\n` +
    "1. If this project defines an image-asset Skill or documents image conventions in its CLAUDE.md / " +
    "README (save path, naming, resizing, database/CDN steps), FOLLOW THAT. Otherwise copy the file into " +
    "the project's conventional static-assets location (the framework-appropriate public/static dir, or " +
    "an imported asset) with a descriptive filename.\n" +
    "2. Wire it into the on-screen element(s) the user selected: set the <img>'s src, or the element's CSS " +
    "background-image, matching the existing patterns in the source.\n" +
    "3. Add a cache-busting query string to the referenced URL (e.g. `?v=<timestamp-or-hash>`) so an " +
    "UPDATED image with the same filename actually refreshes in the browser instead of serving the stale " +
    "cached copy. If the URL already carries such a param, bump it to a new value.\n\n" +
    `Original image request: ${String(imagePrompt).trim()}`,
  ];
  if (screen) parts.push(`\n[Current screen: ${screen}]`);
  const nth = (i) => (elements.length > 1 ? ` (element ${i + 1} of ${elements.length})` : "");
  elements.forEach((element, i) => {
    const ctx = elementContext(element);
    if (ctx)
      parts.push(`\n[The user selected this on-screen element${nth(i)} — place the image here]\n` +
        JSON.stringify(ctx, null, 2) +
        "\nUse the class names / text / DOM path to locate the source, then edit there.");
  });
  if (elements.some((e) => e && e.pasted))
    parts.push("\n[The base image was pasted by the user, not picked from the page.]");
  const extra = (imageInstructions || "").trim();
  if (extra)
    parts.push("\n[Project-specific integration steps — follow these exactly; they take precedence over the above]\n" + extra);
  return parts.join("\n");
}

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

const detailOf = (name, i = {}) =>
  name === "Bash" || name === "run_terminal_command" ? (i.command || "") :
  (name === "Read" || name === "read_file" || EDIT_TOOLS.includes(name) || GROK_EDIT_TOOLS.includes(name))
    ? (i.file_path || i.target_file || i.notebook_path || "") :
  name === "Grep" || name === "Glob" || name === "grep" ? (i.pattern || "") :
  name === "list_dir" ? (i.target_directory || i.path || "") :
  JSON.stringify(i).slice(0, 600);

function resultText(content) {
  let t = typeof content === "string" ? content
    : Array.isArray(content) ? content.map(b => b?.type === "text" ? b.text : JSON.stringify(b)).join("\n")
    : String(content ?? "");
  const trunc = t.length > 4000; return { text: t.slice(0, 4000).trim(), trunc };
}
// Strip the repo prefix for display, tolerating slash-direction and drive-letter-case differences
// between the repo and the path the SDK/transcript recorded (Windows reports `c:\…`, resolve gives `C:\…`).
const relPath = (repo, p) => {
  if (!p) return "";
  const np = p.replace(/\\/g, "/"), nr = repo.replace(/\\/g, "/");
  return np.toLowerCase().startsWith(nr.toLowerCase()) ? np.slice(nr.length).replace(/^\//, "") : p;
};

// --- Chat history (read-only) ----------------------------------------------------------------
// `claude` writes one .jsonl transcript per session under ~/.claude/projects/<encoded-cwd>/.
// The folder name is the cwd with every non-alphanumeric char turned into a single "-". Drive-letter
// case can differ from the repo on Windows, so match the folder case-insensitively against the listing.
const _projDirs = new Map();
async function claudeProjectDir(repo) {
  if (_projDirs.has(repo)) return _projDirs.get(repo);
  const encoded = repo.replace(/[^a-zA-Z0-9]/g, "-");
  const base = join(os.homedir(), ".claude", "projects");
  try {
    const entries = await readdir(base, { withFileTypes: true });
    const hit = entries.find(e => e.isDirectory() && e.name.toLowerCase() === encoded.toLowerCase());
    if (hit) { const dir = join(base, hit.name); _projDirs.set(repo, dir); return dir; }
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
async function listHistory(repo) {
  const dir = await claudeProjectDir(repo);
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
async function readHistory(repo, id) {
  if (!validSessionId(id)) return null;
  const dir = await claudeProjectDir(repo);
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
          if (EDIT_TOOLS.includes(b.name))
            events.push({ type: "file_edit", tool: b.name, path: relPath(repo, b.input?.file_path || ""), id: b.id });
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

// --- Codex (OpenAI) chat history (read-only) -------------------------------------------------
// codex writes one rollout transcript per session under <CODEX_HOME>/sessions/YYYY/MM/DD/
// rollout-<ts>-<uuid>.jsonl. Unlike claude's per-repo folders these all live in one global tree, so
// we read each file's `session_meta` line to filter by cwd === repo. The replayed events come from
// the rollout's `event_msg`/`response_item` records (a different shape than `codex exec --json`'s
// live stream, but mapped onto the same §6 SSE shapes streamCodex emits — `tool`/`file_edit`, no
// `tool_result`, result = last agent message). So `provider:"openai"` history is the codex parallel
// to the claude `~/.claude/projects` history above; the route picks one by the request's provider.
const codexSessionsDir = () => join(codexHome(), "sessions");
const ROLLOUT_RE = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-fA-F-]{36})\.jsonl$/;

// Strip the generic PREAMBLE we prepend to every codex prompt so titles + the replayed user event
// show the actual request (matches claude, whose PREAMBLE rides in systemPrompt, not the message).
function stripPreamble(text) {
  let t = String(text || "");
  if (t.startsWith(PREAMBLE)) t = t.slice(PREAMBLE.length);
  return t.trim();
}

// Read the first `bytes` of a file as utf8. codex's session_meta line carries the whole system
// prompt (~19KB), but `cwd` sits in its first few hundred bytes — enough to pre-filter by repo
// without fully loading the (often multi-hundred-KB) rollouts that belong to other repos.
async function readHead(file, bytes = 4096) {
  let fh;
  try {
    fh = await open(file, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } catch { return ""; }
  finally { try { await fh?.close(); } catch {} }
}

// Walk the codex sessions tree, newest first by the filename's timestamp, yielding {file,id,startedAt}.
async function codexRollouts() {
  let entries;
  try { entries = await readdir(codexSessionsDir(), { recursive: true, withFileTypes: true }); }
  catch { return []; }                              // <CODEX_HOME>/sessions missing
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = ROLLOUT_RE.exec(e.name);
    if (!m) continue;
    const [, Y, Mo, D, h, mi, s, id] = m;
    out.push({ file: join(e.parentPath || e.path, e.name), id,
      startedAt: `${Y}-${Mo}-${D}T${h}:${mi}:${s}` });
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}

// The actual user request out of a codex user_message: drop the PREAMBLE, then keep only the text
// before the first `\n[…]` context marker buildPrompt appends (screen/element/screenshot lines).
const codexRequest = (text) => { const t = stripPreamble(text); return t.split("\n[")[0].trim() || t; };

const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

// List this repo's codex sessions, newest first (parallel to listHistory for the claude path).
async function listCodexHistory(repo) {
  const sessions = [];
  for (const { file, id, startedAt } of await codexRollouts()) {
    const head = await readHead(file);
    const m = CWD_RE.exec(head);                              // cwd lives near the start of session_meta
    if (!m) continue;
    let cwd; try { cwd = JSON.parse(`"${m[1]}"`); } catch { cwd = m[1]; }
    if (resolve(cwd) !== repo) continue;                      // global tree → keep only this repo's sessions
    let lines;
    try { lines = (await readFile(file, "utf8")).split("\n").filter(Boolean); }
    catch { continue; }
    let started = startedAt, endedAt = startedAt, firstPrompt = "", messageCount = 0;
    for (const line of lines) {
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      if (rec.timestamp) { if (rec.type === "session_meta") started = rec.timestamp; endedAt = rec.timestamp; }
      const p = rec.payload || {};
      if (rec.type === "event_msg" && p.type === "user_message") {
        const t = codexRequest(p.message);
        if (t) firstPrompt ||= t;
        messageCount++;
      } else if (rec.type === "event_msg" && p.type === "agent_message") messageCount++;
    }
    sessions.push({ id, title: (firstPrompt || "(untitled)").slice(0, 80),
      firstPrompt: firstPrompt.slice(0, 140), startedAt: started, endedAt, branch: "", messageCount });
  }
  return sessions;   // codexRollouts() already ordered newest-first by timestamp
}

// Parse one codex rollout into render-ready §6 events (parallel to readHistory). Returns null for a
// bad id, a session that isn't in this repo, or a missing file.
async function readCodexHistory(repo, id) {
  if (!validSessionId(id)) return null;
  // The id is the rollout filename's suffix, so one directory scan finds the file — no need to
  // build (and sort) the full listCodexHistory index for a single lookup.
  let entries;
  try { entries = await readdir(codexSessionsDir(), { recursive: true, withFileTypes: true }); }
  catch { return null; }
  const suffix = `-${id.toLowerCase()}.jsonl`;
  const hit = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith(suffix) && ROLLOUT_RE.test(e.name));
  if (!hit) return null;
  let lines;
  try { lines = (await readFile(join(hit.parentPath || hit.path, hit.name), "utf8")).split("\n").filter(Boolean); }
  catch { return null; }
  let meta; try { meta = JSON.parse(lines[0]); } catch { return null; }
  const cwd = meta?.payload?.cwd;
  if (!cwd || resolve(cwd) !== repo) return null;             // don't replay another repo's transcript
  const events = [];
  let lastAgent = null, hadError = false;
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const p = rec.payload || {};
    if (rec.type === "event_msg" && p.type === "user_message") {
      const t = stripPreamble(p.message);
      if (t) events.push({ type: "user", text: t });
    } else if (rec.type === "event_msg" && p.type === "agent_message") {
      if (p.message) { lastAgent = p.message; events.push({ type: "delta", text: p.message }); }
    } else if (rec.type === "event_msg" && p.type === "patch_apply_end") {
      for (const path of Object.keys(p.changes || {}))
        events.push({ type: "file_edit", tool: "codex", path: relPath(repo, path), id: p.call_id });
    } else if (rec.type === "event_msg" && (p.type === "error" || p.type === "stream_error")) {
      hadError = true;
    } else if (rec.type === "response_item" && p.type === "reasoning") {
      for (const s of p.summary || []) if (s?.text) events.push({ type: "thinking_delta", text: s.text });
    } else if (rec.type === "response_item" && p.type === "function_call") {
      let args = {}; try { args = JSON.parse(p.arguments || "{}"); } catch {}
      const detail = args.cmd || args.path || (p.arguments && p.arguments !== "{}" ? p.arguments.slice(0, 200) : "");
      events.push({ type: "tool", tool: p.name === "exec_command" ? "codex_exec" : p.name || "tool",
        detail, id: p.call_id });
    }
  }
  events.push({ type: "result", isError: hadError, numTurns: null, durationMs: null,
    totalCostUsd: null, usage: null, result: lastAgent });
  return { id, events };
}

// --- Grok (xAI) chat history (read-only) -----------------------------------------------------
// Grok writes sessions under ~/.grok/sessions/<encodeURIComponent(cwd)>/<uuid>/ with summary.json
// + chat_history.jsonl. The on-disk history shape ≠ live streaming-messages-json (string content +
// JSON-string tool_calls.arguments), so list/read use a separate mapper. absRepo is always
// realpath(repo) so Node and Python shims share the same session storage key.
const grokSessionsRoot = () => join(grokHome(), "sessions");
const absRepoOf = async (repo) => { try { return await realpath(repo); } catch { return resolve(repo); } };
const grokPrimaryDir = (absRepo) => join(grokSessionsRoot(), encodeURIComponent(absRepo));

// text out of a grok history user line (string or [{type:text,text}])
const grokUserText = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter((b) => b?.type === "text" && b.text).map((b) => b.text).join("\n").trim();
  return "";
};
// First meaningful user prompt for titles: unwrap <user_query> when present, then strip PREAMBLE
// (headless --prompt-file content is often stored inside user_query, so PREAMBLE strip must run after).
const grokFirstPrompt = (text) => {
  let t = String(text || "");
  const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(t);
  if (m) t = m[1];
  t = stripPreamble(t);
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
  t = t.replace(/<user_info>[\s\S]*?<\/user_info>/gi, "").trim();
  return t.split("\n[")[0].trim() || t;
};
const reasoningSummaryText = (summary) => {
  if (typeof summary === "string") return summary;
  if (Array.isArray(summary))
    return summary.map((s) => (typeof s === "string" ? s : s?.text || s?.summary_text || "")).filter(Boolean).join("\n");
  if (summary && typeof summary === "object") return summary.text || summary.summary_text || "";
  return "";
};

// Collect session dirs for this repo: primary encoded-cwd path, plus a realpath-equality scan for
// sessions created with a different cwd string (interactive grok, older shims).
async function grokSessionDirs(absRepo) {
  const found = new Map(); // id → { dir, summary }
  const tryDir = async (dir) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || !validSessionId(e.name)) continue;
      const sdir = join(dir, e.name);
      try {
        const summary = JSON.parse(await readFile(join(sdir, "summary.json"), "utf8"));
        const id = summary?.info?.id || e.name;
        if (!validSessionId(id)) continue;
        found.set(id, { dir: sdir, summary });
      } catch { /* skip */ }
    }
  };
  await tryDir(grokPrimaryDir(absRepo));
  // Fallback scan of all session parent dirs (defensive).
  let parents;
  try { parents = await readdir(grokSessionsRoot(), { withFileTypes: true }); } catch { return [...found.values()]; }
  for (const p of parents) {
    if (!p.isDirectory()) continue;
    const parent = join(grokSessionsRoot(), p.name);
    if (parent === grokPrimaryDir(absRepo)) continue; // already scanned
    let entries;
    try { entries = await readdir(parent, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !validSessionId(e.name) || found.has(e.name)) continue;
      const sdir = join(parent, e.name);
      try {
        const summary = JSON.parse(await readFile(join(sdir, "summary.json"), "utf8"));
        const cwd = summary?.info?.cwd;
        if (!cwd) continue;
        let rc; try { rc = await realpath(cwd); } catch { rc = resolve(cwd); }
        if (rc !== absRepo) continue;
        const id = summary?.info?.id || e.name;
        if (validSessionId(id)) found.set(id, { dir: sdir, summary });
      } catch { /* skip */ }
    }
  }
  return [...found.values()];
}

async function listGrokHistory(repo) {
  const absRepo = await absRepoOf(repo);
  const sessions = [];
  for (const { dir, summary } of await grokSessionDirs(absRepo)) {
    const id = summary?.info?.id || basename(dir);
    let firstPrompt = "";
    try {
      const lines = (await readFile(join(dir, "chat_history.jsonl"), "utf8")).split("\n").filter(Boolean);
      for (const line of lines) {
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type !== "user") continue;
        const t = grokFirstPrompt(grokUserText(rec.content));
        if (t && !t.startsWith("<")) { firstPrompt = t; break; }
        if (t) { firstPrompt ||= t; }
      }
    } catch { /* no history file */ }
    const title = summary.generated_title || summary.session_summary || (firstPrompt || "(untitled)").slice(0, 80);
    sessions.push({
      id,
      title: String(title).slice(0, 80),
      firstPrompt: (firstPrompt || String(title)).slice(0, 140),
      startedAt: summary.created_at || "",
      endedAt: summary.updated_at || summary.last_active_at || summary.created_at || "",
      branch: summary.head_branch || "",
      messageCount: summary.num_chat_messages || summary.num_messages || 0,
    });
  }
  sessions.sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
  return sessions;
}

// History-detail mapper for chat_history.jsonl (≠ live stream). Returns null for bad/missing id.
async function readGrokHistory(repo, id) {
  if (!validSessionId(id)) return null;
  const absRepo = await absRepoOf(repo);
  const dirs = await grokSessionDirs(absRepo);
  const hit = dirs.find((d) => (d.summary?.info?.id || basename(d.dir)) === id);
  if (!hit) return null;
  let lines;
  try { lines = (await readFile(join(hit.dir, "chat_history.jsonl"), "utf8")).split("\n").filter(Boolean); }
  catch { return null; }
  const events = [];
  let lastText = null;
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "system") continue;
    if (rec.type === "user") {
      const t = stripPreamble(grokUserText(rec.content));
      // Skip pure synthetic wrappers.
      if (!t || /^<system-reminder>/.test(t.trim()) || /^<user_info>/.test(t.trim())) continue;
      const cleaned = grokFirstPrompt(t);
      if (cleaned) events.push({ type: "user", text: cleaned });
    } else if (rec.type === "reasoning") {
      const t = reasoningSummaryText(rec.summary);
      if (t) events.push({ type: "thinking_delta", text: t });
    } else if (rec.type === "assistant") {
      if (typeof rec.content === "string" && rec.content) {
        lastText = rec.content;
        events.push({ type: "delta", text: rec.content });
      }
      for (const tc of rec.tool_calls || []) {
        let args = {};
        try { args = typeof tc.arguments === "string" ? JSON.parse(tc.arguments || "{}") : (tc.arguments || {}); }
        catch { args = {}; }
        const name = tc.name || "tool";
        if (GROK_EDIT_TOOLS.includes(name))
          events.push({ type: "file_edit", tool: name, path: relPath(absRepo, args.file_path || ""), id: tc.id });
        else events.push({ type: "tool", tool: name, detail: detailOf(name, args), id: tc.id });
      }
    } else if (rec.type === "tool_result") {
      const { text, trunc } = resultText(rec.content);
      events.push({ type: "tool_result", tool: undefined, id: rec.tool_call_id, text, isError: !!rec.is_error, truncated: trunc });
    } else if (rec.type === "backend_tool_call") {
      events.push({ type: "tool", tool: rec.name || "backend_tool", detail: typeof rec.detail === "string" ? rec.detail : "", id: rec.id });
    }
  }
  events.push({ type: "result", isError: false, numTurns: null, durationMs: null,
    totalCostUsd: null, usage: null, result: lastText });
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
  // Bound the call (parity with the Python shim's 300s urlopen timeout) while still aborting
  // immediately on client disconnect. (AbortSignal.any needs Node 20.3+; compose by hand for 18.)
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("Gemini request timed out")), 300_000);
  timer.unref();
  const onAbort = () => ctl.abort(signal.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      { method: "POST", signal: ctl.signal,
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
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}

// Drive one `claude` query, streaming the §6 SSE events. Returns whether the run errored. Shared by
// runDesign and runImage so the event contract lives in one place.
async function streamQuery(repo, prompt, body, emit, aborted) {
  const tool = {}; let streamedText = false, hadError = false;
  // Live token feed for the client's running counter (§6 `usage`, cumulative). Authoritative
  // per-API-call usage lands with each assistant message — deduped by message id, since partials
  // and multi-block messages repeat it (message_start seeds the entry early with the input/cache
  // counts). Between those, `system/thinking_tokens` estimates progress while the model thinks;
  // that estimate resets when the next authoritative usage arrives (its output_tokens already
  // includes the thinking). Thinking-driven emits are throttled; turn boundaries emit immediately.
  const perMsg = new Map(); let thinkingTokens = 0, lastUsageAt = 0;
  const emitUsage = (force = false) => {
    const now = Date.now();
    if (!force && now - lastUsageAt < 250) return;
    lastUsageAt = now;
    let inp = 0, out = 0, cr = 0, cc = 0;
    for (const u of perMsg.values()) {
      inp += u.input_tokens || 0; out += u.output_tokens || 0;
      cr += u.cache_read_input_tokens || 0; cc += u.cache_creation_input_tokens || 0;
    }
    emit("usage", { inputTokens: inp, outputTokens: out, cacheReadTokens: cr,
      cacheCreationTokens: cc, thinkingTokens });
  };
  // The panel selects from the models discovered during /meta. Omitting either override lets Claude
  // Code apply its own configured default. The actual model is echoed in system/init.
  const model = requestedModel(body) || DEFAULT_MODEL || undefined, effort = selectedEffort(body);
  for await (const m of query({ prompt, options: {
    cwd: repo, permissionMode: "bypassPermissions",  // runs as you (non-root) → allowed, no callback
    allowDangerouslySkipPermissions: true,           // required by the SDK alongside bypassPermissions
    includePartialMessages: true, settingSources: ["project"], systemPrompt: PREAMBLE, maxTurns: 40,
    ...(USE_SKILLS ? { skills: "all" } : {}),                         // load the target repo's project skills
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
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
    else if (m.type === "stream_event" && m.event?.type === "message_start") {
      const msg = m.event.message;
      if (msg?.id && msg.usage) { perMsg.set(msg.id, msg.usage); emitUsage(true); }
    }
    else if (m.type === "system" && m.subtype === "thinking_tokens") {
      thinkingTokens += m.estimated_tokens_delta || 0;
      emitUsage();
    }
    else if (m.type === "assistant") {
      if (m.message?.id && m.message.usage) {
        perMsg.set(m.message.id, m.message.usage);
        thinkingTokens = 0;  // now counted inside this message's output_tokens
        emitUsage(true);
      }
      for (const b of m.message.content ?? []) {
        if (b.type !== "tool_use") continue;
        tool[b.id] = b.name;
        if (EDIT_TOOLS.includes(b.name))
          emit("file_edit", { tool: b.name, path: relPath(repo, b.input?.file_path || ""), id: b.id });
        else emit("tool", { tool: b.name, detail: detailOf(b.name, b.input), id: b.id });
      }
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

// Drive one `codex exec --json` run (the OpenAI provider), mapping codex's JSONL events onto the same
// §6 SSE contract streamQuery emits. Spawns the codex CLI, which reuses CODEX_HOME/auth.json for its
// ChatGPT-oauth login (no API key here). Returns whether the run errored. The generic PREAMBLE is
// prepended to the prompt (codex exec has no separate system-prompt flag).
async function streamCodex(repo, prompt, body, emit, aborted) {
  const model = requestedModel(body), effort = selectedEffort(body);
  const args = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", repo];
  if (model) args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  // Resume a prior codex thread (thread_id is a UUID, so it passes validSessionId). `-` makes codex
  // read the continuation prompt from stdin, same as a fresh run.
  if (validSessionId(body.resume)) args.push("resume", body.resume, "-");
  const env = { ...process.env };
  if (CODEX_HOME) env.CODEX_HOME = CODEX_HOME;
  return new Promise((done) => {
    let child;
    try { child = spawn(CODEX_BIN, args, { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { emit("error", { message: `codex spawn failed: ${e?.message || e}` }); return done(true); }
    let hadError = false, lastText = "", started = false, buf = "", stderr = "", finished = false;
    child.stdin.write(PREAMBLE + "\n\n" + prompt); child.stdin.end();
    child.stdout.setEncoding("utf8");

    const handle = (ev) => {
      if (ev.type === "thread.started") { started = true; emit("start", { sessionId: ev.thread_id, model: model || body.model || "" }); }
      else if (ev.type === "item.completed") {
        const it = ev.item || {};
        if (it.type === "file_change") for (const c of it.changes || []) emit("file_edit", { tool: "codex", path: relPath(repo, c.path || ""), id: it.id });
        else if (it.type === "agent_message") { if (it.text) { lastText = it.text; emit("delta", { text: it.text }); } }
        else if (it.type === "reasoning") { if (it.text) emit("thinking_delta", { text: it.text }); }
        else if (it.type === "command_execution") emit("tool", { tool: "codex_exec", detail: it.command || it.aggregated_output || "", id: it.id });
        else if (it.type === "error") { hadError = true; emit("delta", { text: `\n[error] ${it.message || ""}` }); }
      }
      else if (ev.type === "turn.completed") {
        const u = ev.usage || {};
        emit("usage", { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0,
          cacheReadTokens: u.cached_input_tokens || 0, cacheCreationTokens: 0, thinkingTokens: u.reasoning_output_tokens || 0 });
      }
      else if (ev.type === "error" || ev.type === "turn.failed") {
        hadError = true; emit("delta", { text: `\n[error] ${ev.message || ev.error?.message || "codex run failed"}` });
      }
    };

    child.stdout.on("data", (chunk) => {
      if (aborted()) { try { child.kill("SIGTERM"); } catch {} return; }
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        handle(ev);
      }
    });
    child.stderr.on("data", (c) => { stderr += c; if (DEBUG) console.error("codex stderr:", String(c)); });

    const finish = () => {
      if (finished) return; finished = true;
      if (buf.trim()) { try { handle(JSON.parse(buf)); } catch { /* partial */ } }
      if (aborted()) return done(hadError);            // client gone — match the claude path (no trailing emits)
      if (!started) { hadError = true; emit("error", { message: stderr.trim().slice(0, 500) || "codex did not start" }); }
      emit("result", { isError: hadError, result: lastText || null });
      done(hadError);
    };
    child.on("error", (e) => { if (!started) emit("error", { message: `codex error: ${e?.message || e}` }); hadError = true; finish(); });
    child.on("close", finish);
  });
}

// Drive one headless `grok` run (the xAI provider). Live format is `streaming-messages-json` +
// `--include-partial-messages` (Claude-like Messages wire shape; frozen against grok 1.0.3 — see
// shim/fixtures/grok-streaming-messages-edit.jsonl). Large prompts go through `--prompt-file` (never
// argv `-p`). PREAMBLE is prepended into that file. Auth is host-only: `grok login` / XAI_API_KEY env.
async function streamGrok(repo, prompt, body, emit, aborted) {
  const model = requestedModel(body), effort = selectedEffort(body);
  let absRepo;
  try { absRepo = await realpath(repo); }
  catch (e) { emit("error", { message: `could not resolve repo path: ${e?.message || e}` }); return true; }
  const promptFile = join(os.tmpdir(), `slidewrite-grok-prompt-${Date.now()}-${randomBytes(4).toString("hex")}.txt`);
  try { await writeFile(promptFile, PREAMBLE + "\n\n" + prompt, "utf8"); }
  catch (e) { emit("error", { message: `could not write grok prompt file: ${e?.message || e}` }); return true; }
  const args = [
    "--prompt-file", promptFile,
    "--cwd", absRepo,
    "--output-format", "streaming-messages-json",
    "--include-partial-messages",
    "--always-approve",
    "--permission-mode", "bypassPermissions",
    "--sandbox", "off",
    "--no-auto-update",
    "--max-turns", "40",
  ];
  if (model) args.push("-m", model);
  if (effort) args.push("--effort", effort);
  if (validSessionId(body.resume)) args.push("-r", body.resume);
  const env = { ...process.env };
  if (GROK_HOME) env.GROK_HOME = GROK_HOME;
  const cleanup = async () => { try { await unlink(promptFile); } catch {} };
  return new Promise((done) => {
    let child;
    try { child = spawn(GROK_BIN, args, { cwd: absRepo, env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { cleanup().then(() => { emit("error", { message: `grok spawn failed: ${e?.message || e}` }); done(true); }); return; }
    let hadError = false, streamedText = false, started = false, sawResult = false, buf = "", stderr = "", finished = false;
    const tool = {};
    // Best-effort cumulative usage (parity with streamQuery when message ids exist).
    const perMsg = new Map(); let thinkingTokens = 0, lastUsageAt = 0;
    const emitUsage = (force = false) => {
      const now = Date.now();
      if (!force && now - lastUsageAt < 250) return;
      lastUsageAt = now;
      let inp = 0, out = 0, cr = 0, cc = 0;
      for (const u of perMsg.values()) {
        inp += u.input_tokens || 0; out += u.output_tokens || 0;
        cr += u.cache_read_input_tokens || 0; cc += u.cache_creation_input_tokens || 0;
      }
      emit("usage", { inputTokens: inp, outputTokens: out, cacheReadTokens: cr,
        cacheCreationTokens: cc, thinkingTokens });
    };
    const handle = (m) => {
      if (m.type === "system" && m.subtype === "init") {
        started = true;
        emit("start", { sessionId: m.session_id, model: m.model || model || "" });
      } else if (m.type === "stream_event" && m.event?.type === "content_block_delta") {
        const d = m.event.delta || {};
        if (d.type === "text_delta" && d.text) { streamedText = true; emit("delta", { text: d.text }); }
        else if (d.type === "thinking_delta" && d.thinking) emit("thinking_delta", { text: d.thinking });
      } else if (m.type === "stream_event" && m.event?.type === "message_start") {
        const msg = m.event.message;
        if (msg?.id && msg.usage) { perMsg.set(msg.id, msg.usage); emitUsage(true); }
      } else if (m.type === "system" && m.subtype === "thinking_tokens") {
        thinkingTokens += m.estimated_tokens_delta || 0;
        emitUsage();
      } else if (m.type === "assistant") {
        if (m.message?.id && m.message.usage) {
          perMsg.set(m.message.id, m.message.usage);
          thinkingTokens = 0;
          emitUsage(true);
        }
        for (const b of m.message?.content ?? []) {
          if (b.type !== "tool_use") continue;
          tool[b.id] = b.name;
          if (GROK_EDIT_TOOLS.includes(b.name))
            emit("file_edit", { tool: b.name, path: relPath(absRepo, b.input?.file_path || ""), id: b.id });
          else emit("tool", { tool: b.name, detail: detailOf(b.name, b.input), id: b.id });
        }
      } else if (m.type === "user") {
        const content = m.message?.content;
        for (const b of (Array.isArray(content) ? content : [])) {
          if (b.type !== "tool_result") continue;
          const { text, trunc } = resultText(b.content);
          emit("tool_result", { tool: tool[b.tool_use_id], id: b.tool_use_id, text, isError: !!b.is_error, truncated: trunc });
        }
      } else if (m.type === "result") {
        started = true;
        sawResult = true;
        hadError = !!m.is_error;
        if (m.usage) {
          if (!perMsg.size) perMsg.set("_result", m.usage);
          emitUsage(true);
        }
        emit("result", { isError: hadError, numTurns: m.num_turns, durationMs: m.duration_ms,
          totalCostUsd: m.total_cost_usd, usage: m.usage, result: streamedText ? null : m.result });
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (aborted()) { try { child.kill("SIGTERM"); } catch {} return; }
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (DEBUG) console.error("grok", ev.type, ev.subtype ?? "");
        handle(ev);
      }
    });
    child.stderr.on("data", (c) => { stderr += c; if (DEBUG) console.error("grok stderr:", String(c)); });
    const finish = () => {
      if (finished) return; finished = true;
      if (buf.trim()) { try { handle(JSON.parse(buf)); } catch { /* partial */ } }
      cleanup().finally(() => {
        if (aborted()) return done(hadError);
        if (!started) {
          hadError = true;
          emit("error", { message: (stderr.trim().slice(0, 500) || "grok did not start") +
            " — run `grok login` or set XAI_API_KEY" });
        } else if (!sawResult) {
          // Child exited after init without a terminal `result` line (crash / kill).
          hadError = true;
          emit("error", { message: (stderr.trim().slice(0, 500) || "grok exited without a result") });
          emit("result", { isError: true, result: null });
        }
        done(hadError);
      });
    };
    child.on("error", (e) => {
      if (!started) emit("error", { message: `grok error: ${e?.message || e} — is \`${GROK_BIN}\` on PATH?` });
      hadError = true; finish();
    });
    child.on("close", finish);
  });
}

// Provider dispatch for the agent step. Explicit allow-list — unknown providers hard-error (no
// silent Claude fallthrough). Shared by runDesign and runImage.
function runAgent(repo, prompt, body, emit, aborted) {
  const provider = body.provider || "anthropic";
  if (provider === "anthropic") return streamQuery(repo, prompt, body, emit, aborted);
  if (provider === "openai") return streamCodex(repo, prompt, body, emit, aborted);
  if (provider === "grok") return streamGrok(repo, prompt, body, emit, aborted);
  if (provider === "google") { emit("error", { message: "Google provider is not yet supported" }); return Promise.resolve(true); }
  emit("error", { message: `Unknown provider "${provider}" — upgrade the shim or pick anthropic/openai/grok in options` });
  return Promise.resolve(true);
}

// Commit only what THIS run changed (diff of porcelain before/after); no push.
async function commitChanged(repo, dirty0, subj, emit) {
  const changed = (await porcelainPaths(repo)).filter(p => !dirty0.has(p));
  if (!changed.length) return;
  // `git()` swallows errors, so detect a failed commit (hook rejection, index error) by HEAD not
  // moving — otherwise we'd emit a green `commit` carrying the PREVIOUS head's sha.
  const head0 = await git(repo, "rev-parse", "HEAD");
  await git(repo, "add", "--", ...changed);
  await git(repo, "-c", "user.name=Slide Write", "-c", "user.email=slide-write@local", "commit", "-m", `slide-write: ${subj}`);
  if ((await git(repo, "rev-parse", "HEAD")) === head0)
    return emit("commit_error", { message: "git commit failed (hook rejection or index error) — the run's edits are still in the working tree" });
  emit("commit", { sha: await git(repo, "rev-parse", "--short", "HEAD"), count: changed.length });
}

// Persist a picked-element screenshot (data:<mime>;base64,<data>) to a temp file OUTSIDE the repo so
// `claude` can Read it as an image — same approach runImage uses for generated assets. Returns the
// path, or null when there's no (well-formed) screenshot.
async function saveScreenshot(element, n = 0) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(element?.screenshotDataUrl || "");
  if (!m) return null;
  const ext = m[1].includes("jpeg") ? "jpg" : m[1].includes("webp") ? "webp" : "png";
  const tmpPath = join(os.tmpdir(), `slidewrite-shot-${Date.now()}-${n}.${ext}`);  // -<n>: same-ms picks don't collide
  await writeFile(tmpPath, Buffer.from(m[2], "base64"));
  return tmpPath;
}

// Core: drive one design run. `emit(type, data)` sends an SSE event; `aborted()` lets the caller
// cancel (client disconnect). Exported so the HTTP handler and tests share one implementation.
// `repo` defaults to the single-repo REPO; the HTTP layer passes the Host-resolved repo.
export async function runDesign(body, emit, aborted = () => false, _signal, repo = REPO) {
  const dirty0 = new Set(await porcelainPaths(repo));
  const elements = elementsOf(body);
  const shotPaths = await Promise.all(elements.map((el, i) => saveScreenshot(el, i)));
  const hadError = await runAgent(repo, buildPrompt(body, elements, shotPaths), body, emit, aborted);
  if (aborted()) return;
  // `autoCommit: false` (extension per-origin option) leaves the edits uncommitted in the working
  // tree; absent/anything-else keeps the original auto-commit behavior.
  if (!hadError && body.autoCommit !== false)
    await commitChanged(repo, dirty0, (body.prompt || "design change").split("\n")[0].slice(0, 72), emit);
  emit("done");
}

// Image run: generate the image with Gemini, save it to a temp file OUTSIDE the repo, then drive
// `claude` to place it and wire it into the picked element. The fourth arg is an AbortSignal so the
// (potentially slow) Gemini fetch is cancelled on client disconnect, not just the polled SDK loop.
export async function runImage(body, emit, aborted = () => false, signal, repo = REPO) {
  const key = body.geminiKey || GEMINI_KEY;
  if (!key) { emit("error", { message: "no Gemini API key — set one in the extension options" }); return emit("done"); }
  emit("image_status", { state: "generating" });
  const elements = elementsOf(body);
  // Optional source image for image-to-image (the user picked an <img>): data:<mime>;base64,<data>.
  // With multiple targets, the first element carrying pixels wins — Gemini takes one source image.
  let image;
  for (const e of elements) {
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(e?.imageDataUrl || "");
    if (m) { image = { mimeType: m[1], data: m[2] }; break; }
  }
  const { bytes, mimeType } = await generateImage({ prompt: body.imagePrompt || "", key, image, signal });
  if (aborted()) return;
  const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  const tmpPath = join(os.tmpdir(), `slidewrite-${Date.now()}.${ext}`);
  await writeFile(tmpPath, bytes);
  emit("image_generated", { tmpPath, mimeType, bytes: bytes.length });  // metadata only — no base64 over the wire
  if (aborted()) return;
  const dirty0 = new Set(await porcelainPaths(repo));
  const prompt = buildImagePrompt({ ...body, imageInstructions: body.imageInstructions || IMAGE_INSTRUCTIONS }, elements, tmpPath, !!image);
  const hadError = await runAgent(repo, prompt, body, emit, aborted);
  if (aborted()) return;
  if (!hadError && body.autoCommit !== false)
    await commitChanged(repo, dirty0, `add image — ${(body.imagePrompt || "add image").split("\n")[0].slice(0, 72)}`, emit);
  emit("done");
}

// Generic SSE wrapper: enforce the per-repo busy lock, set stream headers, parse the body, run
// `runner`, and always res.end(). An AbortController is tied to an early client disconnect so an
// in-flight fetch (Gemini) is cancelled too; the polled `aborted()` continues to guard the SDK loop.
async function streamRun(req, res, runner, repo) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
  if (busyRepos.has(repo)) { sse(res, "error", { message: "a run is already in progress" }); sse(res, "done"); return res.end(); }
  busyRepos.add(repo);
  // Abort only on a genuine client disconnect. NB: `req.destroyed` is true the moment the POST
  // body is fully read (Node tears down the request's readable side), so it can't signal
  // disconnect — using it aborts every run on the first SDK message. Watch the *response* for an
  // early `close` (before we've called res.end()) instead.
  let clientGone = false;
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) { clientGone = true; ac.abort(); } });
  try {
    const body = JSON.parse((await readBody(req)) || "{}");
    await runner(body, (t, d) => sse(res, t, d), () => clientGone, ac.signal, repo);
  } catch (e) { sse(res, "error", { message: String(e?.message || e) }); sse(res, "done"); }
  finally { busyRepos.delete(repo); res.end(); }
}

function serve() {
  http.createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    if (path === "/health") return json(res, 200, { ok: true });
    if (!authed(req)) return json(res, 401, { error: "unauthorized" });
    // Routes below operate on a repo — resolved per request from Host in multi-host mode,
    // always REPO otherwise (404 lands before any SSE head is written).
    const repo = await repoFor(req);
    if (!repo) return json(res, 404, { error: "no repo mapped for this host" });
    if (path === "/meta") {
      const [branch, status, modelMeta] = await Promise.all([
        git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
        git(repo, "status", "--porcelain"),
        providerMeta(repo),
      ]);
      return json(res, 200, {
        project: basename(repo), repoDir: repo, version: VERSION,
        branch, dirty: !!status,
        ...modelMeta,  // legacy top-level models/defaultModel = discovered Anthropic list (back-compat)
        geminiModel: GEMINI_MODEL, geminiEnv: !!GEMINI_KEY,  // geminiEnv: shim has a server-side key fallback
      });
    }
    // History is provider-scoped: openai → codex rollouts, grok → ~/.grok/sessions, else claude
    // ~/.claude/projects. The extension sends the per-origin provider as `?provider=`.
    const histProvider = url.searchParams.get("provider") || "anthropic";
    if (path === "/history" && req.method === "GET") {
      const sessions = histProvider === "openai" ? await listCodexHistory(repo)
        : histProvider === "grok" ? await listGrokHistory(repo)
        : await listHistory(repo);
      return json(res, 200, { sessions });
    }
    if (path.startsWith("/history/") && req.method === "GET") {
      const id = decodeURIComponent(path.slice("/history/".length));
      const data = histProvider === "openai" ? await readCodexHistory(repo, id)
        : histProvider === "grok" ? await readGrokHistory(repo, id)
        : await readHistory(repo, id);
      return data ? json(res, 200, data) : json(res, 404, { error: "not found" });
    }
    if (path === "/design" && req.method === "POST") return streamRun(req, res, runDesign, repo);
    if (path === "/generate-image" && req.method === "POST") return streamRun(req, res, runImage, repo);
    json(res, 404, { error: "not found" });
  }).listen(PORT, BIND, () =>
    console.error(`slide-write → http://${BIND}:${PORT}  ` +
      (MULTI_HOST ? `multi-host (repo-root=${REPO_ROOT || "-"}, repos=${REPO_MAP.size}, localhost→${REPO})`
                  : `repo=${REPO}`) + `  origin=${ORIGIN}`));
}

// Start the server only when run directly (so tests can import runDesign without listening).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
