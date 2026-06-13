#!/usr/bin/env python3
# slide-write.py — Python port of slide-write.mjs for servers with only python3 (no Node).
# Same HTTP+SSE surface, same flags/env, same §6/§7 contracts — the extension can't tell them apart.
# Instead of the Node Agent SDK it drives the `claude` CLI headless:
#   claude -p --output-format stream-json --verbose --include-partial-messages …
# which emits the same message stream the SDK yields. `claude` itself needs NO Node either — the
# native installer (curl -fsSL https://claude.ai/install.sh | bash) ships a self-contained binary.
# Stdlib only; Python 3.10+. Keep this file in lockstep with slide-write.mjs (it is the reference).
import base64
import json
import os
import re
import select
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlsplit


def arg(k, d=None):
    a = sys.argv
    flag = f"--{k}"
    return a[a.index(flag) + 1] if flag in a and a.index(flag) + 1 < len(a) else d


PORT = int(arg("port", os.environ.get("SLIDEWRITE_PORT", 4040)))
REPO = os.path.abspath(arg("repo", os.getcwd()))
TOKEN = arg("token", os.environ.get("SLIDEWRITE_TOKEN", ""))
ORIGIN = arg("origin", os.environ.get("SLIDEWRITE_ALLOWED_ORIGIN", "*"))  # app origin, e.g. http://localhost:5173
BIND = arg("bind", os.environ.get("SLIDEWRITE_BIND", "127.0.0.1"))  # §13 fallback only — keep loopback otherwise
# Multi-host mode (§13 generic proxy route): serve MANY repos from one shim, resolving the target
# repo per request from the Host header. `--repos host=path,…` maps hosts explicitly; `--repo-root`
# auto-maps a host's first DNS label to a directory under it (life-ops.dev.x.com → <root>/life-ops).
# When neither is given the shim is single-repo and ignores Host entirely (original behavior).
REPO_ROOT = arg("repo-root", os.environ.get("SLIDEWRITE_REPO_ROOT", ""))
REPO_MAP = {
    s[: s.index("=")].strip().lower(): os.path.abspath(s[s.index("=") + 1 :].strip())
    for s in (arg("repos", os.environ.get("SLIDEWRITE_REPOS", "")) or "").split(",")
    if "=" in s
}
MULTI_HOST = bool(REPO_ROOT or REPO_MAP)
DEBUG = "--debug" in sys.argv or bool(os.environ.get("SW_DEBUG"))  # log each stream message to stderr
# Opt-in: load the target repo's Agent Skills (.claude/skills/*/SKILL.md). The CLI enables skills by
# default (the SDK does not), so parity is inverted: WITHOUT --use-skills we pass
# --disable-slash-commands to match the Node shim's no-skills default.
USE_SKILLS = "--use-skills" in sys.argv or bool(os.environ.get("SLIDEWRITE_USE_SKILLS"))
# The `claude` binary to drive; override when it isn't on PATH (e.g. a systemd unit's bare env).
CLAUDE_BIN = arg("claude-bin", os.environ.get("SLIDEWRITE_CLAUDE_BIN", "claude"))
VERSION = "0.1.0"

# Models the UI may pick from. Advertised via /meta so the client dropdown stays server-driven; a
# `/design` request's `model` is validated against this allowlist before reaching the CLI (an
# unknown id falls back to DEFAULT_MODEL, or the CLI's own default when that's unset). Keep ids in
# sync with the installed `claude` CLI.
MODELS = [
    {"id": "claude-fable-5", "label": "Claude Fable 5"},
    {"id": "claude-opus-4-8", "label": "Claude Opus 4.8"},
    {"id": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6"},
    {"id": "claude-haiku-4-5-20251001", "label": "Claude Haiku 4.5"},
]
DEFAULT_MODEL = arg("model", os.environ.get("SLIDEWRITE_MODEL", ""))  # "" = let the CLI decide


def model_allowed(m):
    return any(x["id"] == m for x in MODELS)


# Gemini "nano banana" image generation. Model id is overridable so a rename doesn't need a code
# edit. The key is a shim-level fallback used only when a /generate-image request omits one (the
# extension normally sends it). IMAGE_INSTRUCTIONS is a fallback for the per-project integration
# steps (asset path, naming, DB write, resize) the request normally carries.
GEMINI_MODEL = arg("gemini-model", os.environ.get("SLIDEWRITE_GEMINI_MODEL", "gemini-2.5-flash-image"))
GEMINI_KEY = arg("gemini-key", os.environ.get("GEMINI_API_KEY", ""))
IMAGE_INSTRUCTIONS = arg("image-instructions", os.environ.get("SLIDEWRITE_IMAGE_INSTRUCTIONS", ""))

PREAMBLE = (
    "You are editing a web app live from within its running dev environment. Your edits land on the "
    "repo at the working directory and the app's own dev server hot-reloads, so changes appear in the "
    "browser within seconds.\n\n"
    "FIRST, read the repo's CLAUDE.md (and README) for THIS project's conventions — where styling "
    "lives, where components/screens live, the framework in use. Follow them.\n\n"
    "- Make the SMALLEST focused change that satisfies the request, in the spirit of the existing code.\n"
    "- Reuse existing tokens/components/patterns; don't add dependencies unless asked.\n"
    "- Do NOT edit Dockerfiles, CI, or anything under .claude / .env / credentials.\n"
    "- Keep schema/model changes ADDITIVE; never rename/drop/retype an existing column.\n"
    "- When done, reply with one or two sentences describing exactly what you changed."
)


def git(repo, *a):
    try:
        out = subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True).stdout
    except OSError:
        out = ""
    return (out or "").strip()


# NB: parse porcelain UNtrimmed — `" M file"` starts with a space the status column needs.
def porcelain_paths(repo):
    try:
        out = subprocess.run(
            ["git", "-C", repo, "status", "--porcelain", "-uall"], capture_output=True, text=True
        ).stdout
    except OSError:
        out = ""
    return [line[3:] for line in (out or "").split("\n") if line]


# Resolve the repo a request targets. Single-repo mode always answers REPO. Multi-host mode:
# explicit --repos entry → localhost fallback to --repo → first-DNS-label lookup under
# --repo-root (label sanitized: a Host header is attacker-controlled text, never a path).
# Returns None when nothing maps — the caller 404s.
LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "[::1]"}


def repo_for(host_header):
    if not MULTI_HOST:
        return REPO
    hostname = re.sub(r":\d+$", "", str(host_header or "")).lower()
    if hostname in REPO_MAP:
        return REPO_MAP[hostname]
    if hostname in LOCAL_HOSTNAMES:
        return REPO
    label = hostname.split(".")[0]
    if REPO_ROOT and re.fullmatch(r"[a-z0-9-]+", label):
        d = os.path.join(os.path.abspath(REPO_ROOT), label)
        if os.path.isdir(d):
            return d
    return None


UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def valid_session_id(sid):
    return isinstance(sid, str) and bool(UUID_RE.match(sid))


busy_repos = set()  # one run at a time PER REPO; different repos may run concurrently
busy_lock = threading.Lock()


# The §7 element-capture contract, serialized for the prompt. Single-sourced so build_prompt and
# build_image_prompt stay in sync. Returns None when there's nothing useful to send.
def element_context(element):
    if not isinstance(element, dict):
        return None
    ctx = {
        k: v
        for k, v in {
            "tag": element.get("tag"), "id": element.get("id"), "class": element.get("className"),
            "text": element.get("text"), "domPath": element.get("domPath"), "rect": element.get("rect"),
        }.items()
        if v
    }
    return ctx or None


# Normalize a request's element targets: the §7 `elements` array (the composer stacks up to
# MAX_ELEMENTS picks), with the legacy single `element` still accepted. Capped server-side too, so
# an oversized payload can't balloon the prompt/context window.
MAX_ELEMENTS = 5


def elements_of(body):
    els = body.get("elements") if isinstance(body.get("elements"), list) else (
        [body["element"]] if body.get("element") else []
    )
    return [e for e in els if e][:MAX_ELEMENTS]


def build_prompt(body, elements=(), shot_paths=()):
    parts = [str(body.get("prompt", "")).strip()]
    if body.get("screen"):
        parts.append(f"\n[Current screen: {body['screen']}]")
    nth = lambda i: f" (element {i + 1} of {len(elements)})" if len(elements) > 1 else ""
    for i, element in enumerate(elements):
        ctx = element_context(element)
        if ctx:
            parts.append(
                f"\n[The user clicked this on-screen element{nth(i)} and is referring to it]\n"
                + json.dumps(ctx, indent=2)
                + "\nUse the class names / text / DOM path to locate the source and matching styles, then edit there."
            )
        if i < len(shot_paths) and shot_paths[i]:
            parts.append(
                f"\n[A screenshot of the selected element{nth(i)} was saved at:\n  {shot_paths[i]}\n"
                "(this file is OUTSIDE the repo). Read it to see how the element currently looks before editing.]"
            )
    return "\n".join(parts)


# Prompt for an image run: the image already exists on disk at `tmp_path` (outside the repo). Tell
# claude to place it per the project's conventions and wire it into the picked element. Stays
# generic — framework specifics live in the target repo's CLAUDE.md. The per-project
# `imageInstructions` (exact path, naming, DB write, resize…) are appended last and take precedence.
def build_image_prompt(body, elements, tmp_path, has_source):
    parts = [
        ("A newly edited version of the selected image has been generated and saved on disk at:"
         if has_source else "A new image has been generated and saved on disk at:")
        + f"\n  {tmp_path}\n(this file is OUTSIDE the repo). Then:\n"
        "1. If this project defines an image-asset Skill or documents image conventions in its CLAUDE.md / "
        "README (save path, naming, resizing, database/CDN steps), FOLLOW THAT. Otherwise copy the file into "
        "the project's conventional static-assets location (the framework-appropriate public/static dir, or "
        "an imported asset) with a descriptive filename.\n"
        "2. Wire it into the on-screen element(s) the user selected: set the <img>'s src, or the element's CSS "
        "background-image, matching the existing patterns in the source.\n"
        "3. Add a cache-busting query string to the referenced URL (e.g. `?v=<timestamp-or-hash>`) so an "
        "UPDATED image with the same filename actually refreshes in the browser instead of serving the stale "
        "cached copy. If the URL already carries such a param, bump it to a new value.\n\n"
        f"Original image request: {str(body.get('imagePrompt', '')).strip()}"
    ]
    if body.get("screen"):
        parts.append(f"\n[Current screen: {body['screen']}]")
    nth = lambda i: f" (element {i + 1} of {len(elements)})" if len(elements) > 1 else ""
    for i, element in enumerate(elements):
        ctx = element_context(element)
        if ctx:
            parts.append(
                f"\n[The user selected this on-screen element{nth(i)} — place the image here]\n"
                + json.dumps(ctx, indent=2)
                + "\nUse the class names / text / DOM path to locate the source, then edit there."
            )
    extra = (body.get("imageInstructions") or "").strip()
    if extra:
        parts.append(
            "\n[Project-specific integration steps — follow these exactly; they take precedence over the above]\n"
            + extra
        )
    return "\n".join(parts)


EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")


def detail_of(name, i=None):
    i = i or {}
    if name == "Bash":
        return i.get("command", "")
    if name in ("Read", "Edit", "Write", "MultiEdit", "NotebookEdit"):
        return i.get("file_path") or i.get("notebook_path") or ""
    if name in ("Grep", "Glob"):
        return i.get("pattern", "")
    return json.dumps(i)[:600]


def result_text(content):
    if isinstance(content, str):
        t = content
    elif isinstance(content, list):
        t = "\n".join(
            b.get("text", "") if isinstance(b, dict) and b.get("type") == "text" else json.dumps(b)
            for b in content
        )
    else:
        t = str(content if content is not None else "")
    return t[:4000].strip(), len(t) > 4000


# Strip the repo prefix for display, tolerating slash-direction and drive-letter-case differences
# between the repo and the path the CLI/transcript recorded (Windows reports `c:\…`, abspath gives `C:\…`).
def rel_path(repo, p):
    if not p:
        return ""
    np, nr = p.replace("\\", "/"), repo.replace("\\", "/")
    return np[len(nr):].lstrip("/") if np.lower().startswith(nr.lower()) else p


# --- Chat history (read-only) ----------------------------------------------------------------
# `claude` writes one .jsonl transcript per session under ~/.claude/projects/<encoded-cwd>/.
# The folder name is the cwd with every non-alphanumeric char turned into a single "-". Drive-letter
# case can differ from the repo on Windows, so match the folder case-insensitively against the listing.
_proj_dirs = {}


def claude_project_dir(repo):
    if repo in _proj_dirs:
        return _proj_dirs[repo]
    encoded = re.sub(r"[^a-zA-Z0-9]", "-", repo)
    base = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    try:
        for name in os.listdir(base):
            d = os.path.join(base, name)
            if os.path.isdir(d) and name.lower() == encoded.lower():
                _proj_dirs[repo] = d
                return d
    except OSError:
        pass  # ~/.claude/projects missing
    return None


# Pull the text out of a user message's content (array of blocks, or a bare string).
def user_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        t = "\n".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        ).strip()
        if t:
            return t
        return "[image]" if any(isinstance(b, dict) and b.get("type") == "image" for b in content) else ""
    return ""


# List this repo's sessions, newest first. One pass per .jsonl file extracts a summary.
def list_history(repo):
    d = claude_project_dir(repo)
    if not d:
        return []
    try:
        files = [f for f in os.listdir(d) if f.endswith(".jsonl") and os.path.isfile(os.path.join(d, f))]
    except OSError:
        return []
    sessions = []
    for fname in files:
        try:
            with open(os.path.join(d, fname), encoding="utf-8") as fh:
                lines = [ln for ln in fh.read().split("\n") if ln]
            title = first_prompt = started_at = ended_at = branch = ""
            message_count = 0
            for line in lines:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("timestamp"):
                    started_at = started_at or rec["timestamp"]
                    ended_at = rec["timestamp"]
                if rec.get("gitBranch") and not branch:
                    branch = rec["gitBranch"]
                if rec.get("type") == "ai-title" and rec.get("aiTitle"):
                    title = rec["aiTitle"]
                elif rec.get("type") == "user" and rec.get("message"):
                    t = user_text(rec["message"].get("content"))
                    if t and not t.startswith("[image]"):
                        first_prompt = first_prompt or t
                    message_count += 1
                elif rec.get("type") == "assistant":
                    message_count += 1
            if not title:
                title = (first_prompt or "(untitled)")[:80]
            sessions.append({
                "id": fname[: -len(".jsonl")], "title": title,
                "firstPrompt": first_prompt[:140], "startedAt": started_at, "endedAt": ended_at,
                "branch": branch, "messageCount": message_count,
            })
        except OSError:
            pass  # skip unreadable transcript
    sessions.sort(key=lambda s: s.get("endedAt") or "", reverse=True)
    return sessions


# Parse one transcript into render-ready events mirroring the §6 SSE shapes (plus a `user` event), so
# the panel replays it through the same onEvent renderer. Returns None for a bad/missing id.
def read_history(repo, sid):
    if not valid_session_id(sid):
        return None
    d = claude_project_dir(repo)
    if not d:
        return None
    file = os.path.abspath(os.path.join(d, f"{sid}.jsonl"))
    if not file.startswith(d + os.sep):  # belt-and-suspenders traversal guard (id is already UUID-validated)
        return None
    try:
        with open(file, encoding="utf-8") as fh:
            lines = [ln for ln in fh.read().split("\n") if ln]
    except OSError:
        return None
    tool, events = {}, []
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        content = (rec.get("message") or {}).get("content")
        if rec.get("type") == "assistant" and isinstance(content, list):
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and b.get("text"):
                    events.append({"type": "delta", "text": b["text"]})
                elif b.get("type") == "thinking" and b.get("thinking"):
                    events.append({"type": "thinking_delta", "text": b["thinking"]})
                elif b.get("type") == "tool_use":
                    tool[b.get("id")] = b.get("name")
                    if b.get("name") in EDIT_TOOLS:
                        events.append({"type": "file_edit", "tool": b["name"],
                                       "path": rel_path(repo, (b.get("input") or {}).get("file_path", "")),
                                       "id": b.get("id")})
                    else:
                        events.append({"type": "tool", "tool": b.get("name"),
                                       "detail": detail_of(b.get("name"), b.get("input")), "id": b.get("id")})
        elif rec.get("type") == "user":
            blocks = content if isinstance(content, list) else [{"type": "text", "text": user_text(content)}]
            results = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_result"]
            if results:
                for b in results:
                    text, trunc = result_text(b.get("content"))
                    events.append({"type": "tool_result", "tool": tool.get(b.get("tool_use_id")),
                                   "id": b.get("tool_use_id"), "text": text,
                                   "isError": bool(b.get("is_error")), "truncated": trunc})
            else:
                t = user_text(content)
                if t:
                    events.append({"type": "user", "text": t})
        elif rec.get("type") == "result":
            events.append({"type": "result", "isError": bool(rec.get("is_error")),
                           "numTurns": rec.get("num_turns"), "durationMs": rec.get("duration_ms"),
                           "totalCostUsd": rec.get("total_cost_usd"), "usage": rec.get("usage"), "result": None})
    return {"id": sid, "events": events}


# Generate (or edit) an image with Gemini "nano banana" via the Generative Language REST API.
# Generic — knows nothing about the target repo. The key goes in a header (never the URL, so it
# can't leak into request logs); `image` (optional, {mimeType,data}) makes it image-to-image.
# Returns (bytes, mime) or raises a clean, key-free Exception. NB: unlike the Node shim there is no
# abort signal — a client disconnect is noticed after the call returns (the run then stops there).
def generate_image(prompt, key, image=None):
    parts = []
    if image:
        parts.append({"inlineData": {"mimeType": image["mimeType"], "data": image["data"]}})
    parts.append({"text": prompt})
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{quote(GEMINI_MODEL, safe='')}:generateContent",
        data=json.dumps({"contents": [{"parts": parts}],
                         "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]}}).encode(),
        headers={"content-type": "application/json", "x-goog-api-key": key}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            data = json.loads(res.read())
    except urllib.error.HTTPError as e:
        msg = f"HTTP {e.code}"
        try:
            msg = json.loads(e.read()).get("error", {}).get("message") or msg
        except ValueError:
            pass  # non-JSON body
        raise Exception(f"Gemini {e.code}: {msg}") from None
    if (data.get("promptFeedback") or {}).get("blockReason"):
        raise Exception(f"Gemini blocked the prompt: {data['promptFeedback']['blockReason']}")
    cand = (data.get("candidates") or [{}])[0]
    for p in (cand.get("content") or {}).get("parts") or []:
        inl = p.get("inlineData") or p.get("inline_data")  # v1beta JSON returns camelCase; accept both
        if inl and inl.get("data"):
            return base64.b64decode(inl["data"]), inl.get("mimeType") or inl.get("mime_type") or "image/png"
    fr = cand.get("finishReason")
    why = f" (finishReason: {fr})" if fr and fr != "STOP" else ""
    raise Exception(f"Gemini returned no image{why}")


# Drive one `claude` run, streaming the §6 SSE events. Returns whether the run errored. Shared by
# run_design and run_image so the event contract lives in one place. The CLI's stream-json output is
# the same message stream the Node Agent SDK yields, so the mapping below mirrors slide-write.mjs
# line for line; the prompt goes in on stdin (no argv size/quoting worries).
def stream_query(repo, prompt, body, emit, aborted):
    tool = {}
    streamed_text = had_error = saw_result = False
    # Live token feed for the client's running counter (§6 `usage`, cumulative). Authoritative
    # per-API-call usage lands with each assistant message — deduped by message id, since partials
    # and multi-block messages repeat it (message_start seeds the entry early with the input/cache
    # counts). Between those, `system/thinking_tokens` estimates progress while the model thinks;
    # that estimate resets when the next authoritative usage arrives (its output_tokens already
    # includes the thinking). Thinking-driven emits are throttled; turn boundaries emit immediately.
    per_msg = {}
    thinking_tokens = 0
    last_usage_at = 0.0

    def emit_usage(force=False):
        nonlocal last_usage_at
        now = time.monotonic()
        if not force and now - last_usage_at < 0.25:
            return
        last_usage_at = now
        inp = out = cr = cc = 0
        for u in per_msg.values():
            inp += u.get("input_tokens") or 0
            out += u.get("output_tokens") or 0
            cr += u.get("cache_read_input_tokens") or 0
            cc += u.get("cache_creation_input_tokens") or 0
        emit("usage", {"inputTokens": inp, "outputTokens": out, "cacheReadTokens": cr,
                       "cacheCreationTokens": cc, "thinkingTokens": thinking_tokens})

    # Resolve the requested model against the allowlist; fall back to DEFAULT_MODEL (or, if that's
    # unset, omit `--model` entirely so the CLI uses its own default). The actual model the CLI runs
    # is echoed back to the client in the `start` event from system/init.
    model = body.get("model") if model_allowed(body.get("model")) else (DEFAULT_MODEL or None)
    cmd = [CLAUDE_BIN, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
           "--dangerously-skip-permissions",       # runs as you (non-root) → allowed, no callback
           "--setting-sources", "project",         # project CLAUDE.md only, like the SDK shim
           "--system-prompt", PREAMBLE, "--max-turns", "40"]
    if not USE_SKILLS:
        cmd.append("--disable-slash-commands")     # CLI loads skills by default; mirror the SDK's opt-in
    if model:
        cmd += ["--model", model]
    if valid_session_id(body.get("resume")):       # continue a prior session if asked
        cmd += ["--resume", body["resume"]]
    try:
        proc = subprocess.Popen(cmd, cwd=repo, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding="utf-8")
    except OSError as e:
        emit("error", {"message": f"could not start `{CLAUDE_BIN}`: {e}"})
        return True

    def feed():  # threaded: a >64KB prompt must not deadlock against an unread stdout pipe
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
        except OSError:
            pass

    err_tail = deque(maxlen=40)

    def drain():  # keep stderr flowing; remember the tail for a useful error message
        for line in proc.stderr:
            err_tail.append(line)

    threading.Thread(target=feed, daemon=True).start()
    threading.Thread(target=drain, daemon=True).start()
    try:
        for line in proc.stdout:
            if aborted():
                proc.kill()
                return had_error
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if DEBUG:
                print("CLI", m.get("type"), m.get("subtype", ""), file=sys.stderr)
            t, sub = m.get("type"), m.get("subtype")
            if t == "system" and sub == "init":
                emit("start", {"sessionId": m.get("session_id"), "model": m.get("model")})
            elif t == "stream_event" and (m.get("event") or {}).get("type") == "content_block_delta":
                d = m["event"].get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    streamed_text = True
                    emit("delta", {"text": d["text"]})
                elif d.get("type") == "thinking_delta" and d.get("thinking"):
                    emit("thinking_delta", {"text": d["thinking"]})
            elif t == "stream_event" and (m.get("event") or {}).get("type") == "message_start":
                msg = m["event"].get("message") or {}
                if msg.get("id") and msg.get("usage"):
                    per_msg[msg["id"]] = msg["usage"]
                    emit_usage(True)
            elif t == "system" and sub == "thinking_tokens":
                thinking_tokens += m.get("estimated_tokens_delta") or 0
                emit_usage()
            elif t == "assistant":
                msg = m.get("message") or {}
                if msg.get("id") and msg.get("usage"):
                    per_msg[msg["id"]] = msg["usage"]
                    thinking_tokens = 0  # now counted inside this message's output_tokens
                    emit_usage(True)
                for b in msg.get("content") or []:
                    if not isinstance(b, dict) or b.get("type") != "tool_use":
                        continue
                    tool[b.get("id")] = b.get("name")
                    if b.get("name") in EDIT_TOOLS:
                        emit("file_edit", {"tool": b["name"],
                                           "path": rel_path(repo, (b.get("input") or {}).get("file_path", "")),
                                           "id": b.get("id")})
                    else:
                        emit("tool", {"tool": b.get("name"), "detail": detail_of(b.get("name"), b.get("input")),
                                      "id": b.get("id")})
            elif t == "user":
                content = (m.get("message") or {}).get("content")
                for b in content if isinstance(content, list) else []:
                    if not isinstance(b, dict) or b.get("type") != "tool_result":
                        continue
                    text, trunc = result_text(b.get("content"))
                    emit("tool_result", {"tool": tool.get(b.get("tool_use_id")), "id": b.get("tool_use_id"),
                                         "text": text, "isError": bool(b.get("is_error")), "truncated": trunc})
            elif t == "result":
                saw_result = True
                had_error = bool(m.get("is_error"))
                emit("result", {"isError": had_error, "numTurns": m.get("num_turns"),
                                "durationMs": m.get("duration_ms"), "totalCostUsd": m.get("total_cost_usd"),
                                "usage": m.get("usage"), "result": None if streamed_text else m.get("result")})
        proc.wait()
        # The SDK surfaces process failures as exceptions; here a dead CLI just closes stdout. A
        # nonzero exit with no `result` message (bad flag, login problem, crash) must not look like
        # a clean run — surface the stderr tail.
        if proc.returncode != 0 and not saw_result and not aborted():
            emit("error", {"message": f"claude exited {proc.returncode}: " + "".join(err_tail)[-2000:].strip()})
            had_error = True
    finally:
        if proc.poll() is None:
            proc.kill()
    return had_error


# Commit only what THIS run changed (diff of porcelain before/after); no push.
def commit_changed(repo, dirty0, subj, emit):
    changed = [p for p in porcelain_paths(repo) if p not in dirty0]
    if not changed:
        return
    # `git()` swallows errors, so detect a failed commit (hook rejection, index error) by HEAD not
    # moving — otherwise we'd emit a green `commit` carrying the PREVIOUS head's sha.
    head0 = git(repo, "rev-parse", "HEAD")
    git(repo, "add", "--", *changed)
    git(repo, "-c", "user.name=Slide Write", "-c", "user.email=slide-write@local", "commit", "-m",
        f"slide-write: {subj}")
    if git(repo, "rev-parse", "HEAD") == head0:
        return emit("commit_error", {"message": "git commit failed (hook rejection or index error) — "
                                                "the run's edits are still in the working tree"})
    emit("commit", {"sha": git(repo, "rev-parse", "--short", "HEAD"), "count": len(changed)})


DATA_URL_RE = re.compile(r"^data:([^;,]+);base64,(.+)$", re.S)


# Persist a picked-element screenshot (data:<mime>;base64,<data>) to a temp file OUTSIDE the repo so
# `claude` can Read it as an image — same approach run_image uses for generated assets. Returns the
# path, or None when there's no (well-formed) screenshot.
def save_screenshot(element, n=0):
    m = DATA_URL_RE.match((element or {}).get("screenshotDataUrl") or "")
    if not m:
        return None
    ext = "jpg" if "jpeg" in m.group(1) else "webp" if "webp" in m.group(1) else "png"
    tmp_path = os.path.join(tempfile.gettempdir(),
                            f"slidewrite-shot-{int(time.time() * 1000)}-{n}.{ext}")  # -<n>: same-ms picks don't collide
    with open(tmp_path, "wb") as fh:
        fh.write(base64.b64decode(m.group(2)))
    return tmp_path


# Core: drive one design run. `emit(type, data)` sends an SSE event; `aborted()` lets the caller
# cancel (client disconnect). Module-level so the HTTP handler and tests share one implementation.
# `repo` defaults to the single-repo REPO; the HTTP layer passes the Host-resolved repo.
def run_design(body, emit, aborted=lambda: False, repo=None):
    repo = repo or REPO
    dirty0 = set(porcelain_paths(repo))
    elements = elements_of(body)
    shot_paths = [save_screenshot(el, i) for i, el in enumerate(elements)]
    had_error = stream_query(repo, build_prompt(body, elements, shot_paths), body, emit, aborted)
    if aborted():
        return
    # `autoCommit: false` (extension per-origin option) leaves the edits uncommitted in the working
    # tree; absent/anything-else keeps the original auto-commit behavior.
    if not had_error and body.get("autoCommit") is not False:
        commit_changed(repo, dirty0, (body.get("prompt") or "design change").split("\n")[0][:72], emit)
    emit("done")


# Image run: generate the image with Gemini, save it to a temp file OUTSIDE the repo, then drive
# `claude` to place it and wire it into the picked element.
def run_image(body, emit, aborted=lambda: False, repo=None):
    repo = repo or REPO
    key = body.get("geminiKey") or GEMINI_KEY
    if not key:
        emit("error", {"message": "no Gemini API key — set one in the extension options"})
        return emit("done")
    emit("image_status", {"state": "generating"})
    elements = elements_of(body)
    # Optional source image for image-to-image (the user picked an <img>): data:<mime>;base64,<data>.
    # With multiple targets, the first element carrying pixels wins — Gemini takes one source image.
    image = None
    for e in elements:
        m = DATA_URL_RE.match((e or {}).get("imageDataUrl") or "")
        if m:
            image = {"mimeType": m.group(1), "data": m.group(2)}
            break
    img_bytes, mime_type = generate_image(body.get("imagePrompt") or "", key, image)
    if aborted():
        return
    ext = "jpg" if "jpeg" in mime_type else "webp" if "webp" in mime_type else "png"
    tmp_path = os.path.join(tempfile.gettempdir(), f"slidewrite-{int(time.time() * 1000)}.{ext}")
    with open(tmp_path, "wb") as fh:
        fh.write(img_bytes)
    emit("image_generated", {"tmpPath": tmp_path, "mimeType": mime_type, "bytes": len(img_bytes)})  # metadata only
    if aborted():
        return
    dirty0 = set(porcelain_paths(repo))
    prompt = build_image_prompt(
        {**body, "imageInstructions": body.get("imageInstructions") or IMAGE_INSTRUCTIONS},
        elements, tmp_path, bool(image))
    had_error = stream_query(repo, prompt, body, emit, aborted)
    if aborted():
        return
    if not had_error and body.get("autoCommit") is not False:
        subj = (body.get("imagePrompt") or "add image").split("\n")[0][:72]
        commit_changed(repo, dirty0, f"add image — {subj}", emit)
    emit("done")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # quiet per-request logging, like the Node shim
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", ORIGIN)
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")  # https→localhost PNA; harmless otherwise

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _authed(self):
        return bool(TOKEN) and self.headers.get("authorization") == f"Bearer {TOKEN}"

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            return self._json(200, {"ok": True})
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        repo = repo_for(self.headers.get("host"))
        if not repo:
            return self._json(404, {"error": "no repo mapped for this host"})
        if path == "/meta":
            return self._json(200, {
                "project": os.path.basename(repo), "repoDir": repo, "version": VERSION,
                "branch": git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
                "dirty": bool(git(repo, "status", "--porcelain")),
                "models": MODELS, "defaultModel": DEFAULT_MODEL or MODELS[0]["id"],
                "geminiModel": GEMINI_MODEL, "geminiEnv": bool(GEMINI_KEY),  # geminiEnv: server-side key fallback
            })
        if path == "/history":
            return self._json(200, {"sessions": list_history(repo)})
        if path.startswith("/history/"):
            data = read_history(repo, unquote(path[len("/history/"):]))
            return self._json(200, data) if data else self._json(404, {"error": "not found"})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlsplit(self.path).path
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        if path == "/design":
            return self._stream_run(run_design)
        if path == "/generate-image":
            return self._stream_run(run_image)
        self._json(404, {"error": "not found"})

    # Generic SSE wrapper: enforce the per-repo busy lock, set stream headers, parse the body, run
    # `runner`, and always finish the stream. The response is close-delimited (`Connection: close` —
    # BaseHTTPRequestHandler doesn't chunk), which the extension's fetch-reader handles fine. A
    # client disconnect is detected two ways: a failed emit() write, and aborted() peeking the
    # socket for EOF between stream messages — either stops the run and kills the `claude` child.
    def _stream_run(self, runner):
        repo = repo_for(self.headers.get("host"))
        if not repo:
            return self._json(404, {"error": "no repo mapped for this host"})
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        gone = {"v": False}

        def emit(t, d=None):
            if gone["v"]:
                return
            try:
                self.wfile.write(f"data: {json.dumps({'type': t, **(d or {})})}\n\n".encode())
                self.wfile.flush()
            except OSError:
                gone["v"] = True

        def aborted():
            if gone["v"]:
                return True
            try:
                r, _, _ = select.select([self.connection], [], [], 0)
                # readable + MSG_PEEK reads b"" ⇒ the client closed (FIN); readable with data is fine
                if r and self.connection.recv(1, socket.MSG_PEEK | getattr(socket, "MSG_DONTWAIT", 0)) == b"":
                    gone["v"] = True
            except (OSError, ValueError):
                gone["v"] = True
            return gone["v"]

        with busy_lock:
            busy = repo in busy_repos
            if not busy:
                busy_repos.add(repo)
        if busy:
            emit("error", {"message": "a run is already in progress"})
            emit("done")
            return
        try:
            body = json.loads(raw or b"{}")
            runner(body, emit, aborted, repo)
        except Exception as e:  # surface run failures on the stream, never a half-closed socket
            emit("error", {"message": str(e)})
            emit("done")
        finally:
            with busy_lock:
                busy_repos.discard(repo)


def serve():
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    srv.daemon_threads = True
    print(
        f"slide-write (py) → http://{BIND}:{PORT}  "
        + (f"multi-host (repo-root={REPO_ROOT or '-'}, repos={len(REPO_MAP)}, localhost→{REPO})"
           if MULTI_HOST else f"repo={REPO}")
        + f"  origin={ORIGIN}",
        file=sys.stderr)
    srv.serve_forever()


# Start the server only when run directly (so tests can import run_design without listening).
if __name__ == "__main__":
    serve()
