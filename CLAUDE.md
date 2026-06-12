# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Slide Write — a portable AI design assistant: a tiny local **shim** that drives `claude` headless
against a target repo and streams the run as SSE, plus a **browser extension** that injects an
element-picker + chat overlay into the running app. Click an element or type a request → `claude`
edits the real source → the dev server hot-reloads. **README.md is the authoritative spec** — read
it and implement/extend in the order of its §12 "Build order for Claude".

**Current state: built.** Both `shim/` and `extension/` exist and run; on top of the original
`/design` flow the shim adds chat history, session resume, model selection, **Gemini "nano
banana" image generation** (`POST /generate-image`, the `image_status`/`image_generated` SSE events,
and the §7 `imageDataUrl` capture field), **multi-host mode** (README §5.2: `--repo-root`/
`--repos` resolve the target repo per request from the `Host` header behind the §13 reverse proxy;
single-repo localhost behavior is unchanged when those flags are absent), an **auto-commit
opt-out** (per-origin extension checkbox → top-level `autoCommit` on each run; only an explicit
`false` makes the shim skip the per-run commit), and **multi-element targets** (the picker stays
armed for consecutive picks; up to 5 stacked §7 captures POSTed as a top-level `elements` array,
capped at 5 on both sides, with the legacy single `element` still accepted). README.md remains the authoritative spec — it inlines every
contract and the load-bearing code verbatim (§5 shim, §8.2 SSE reader); treat those as authoritative
and extend them in lockstep. The mechanical parts (UI rendering, helpers) may be implemented freely
as long as they honor the contracts.

## Architecture (two deliverables)
- `shim/` — a cross-platform **Node CLI** (`slide-write.mjs`) that serves HTTP+SSE on
  `127.0.0.1:<port>` and drives `claude` via `@anthropic-ai/claude-agent-sdk` with `cwd` = the
  target repo. Reuses `~/.claude` (no API key). Auto-commits only the files it edits (no push).
- `extension/` — Manifest V3 browser extension; the universal, framework-agnostic UI (element picker
  + chat) injected via a content script into a Shadow DOM. Talks HTTP+SSE to the shim at
  `http://localhost:<port>`.

**Transport = VS Code port forwarding.** The shim binds loopback on whatever machine the code lives
on; VS Code forwards that port (and the app's dev port) to the UI machine's `localhost`. So local
dev and remote dev (Remote-SSH / WSL / Dev Container / Codespaces) look identical to the extension,
on Win/macOS/Linux. The shim and the dev server share the repo via the filesystem; `claude` writes,
the dev server hot-reloads.

## Invariants — do not regress these (each is load-bearing; see README for why)
- **The shim binds `127.0.0.1` by default**, never a public interface. Reached via VS Code's port
  forward or directly on the same machine. The opt-in `--bind`/`SLIDEWRITE_BIND` override exists
  only for the README §13 reverse-proxy fallback (docker bridge gateway); the loopback default must
  not change.
- **The shim runs as you (non-root)**, so `permissionMode: "bypassPermissions"` works directly — no
  permission-prompt callback, no streaming-input dance, no root/Docker workarounds. Edits are
  host-owned. (The SDK *requires* `allowDangerouslySkipPermissions: true` set alongside it.)
- **Commit what GIT says changed during the run** (diff of `git status --porcelain` before/after),
  not just Edit/Write tool calls — `claude` often edits via `Bash`, which Edit-tracking misses.
  Parse porcelain **untrimmed** (the `porcelainPaths()` helper): a leading status-column space is
  significant for `line.slice(3)`, so a trimming `git()` would corrupt the first path.
- **The SSE stream runs in the content script, not the MV3 service worker** (the worker is killed
  ~30s idle, mid-run). The reader uses `fetch` + `getReader`, never `EventSource`.
- **The bearer token + the CORS origin allowlist are the two security gates.** Every shim route
  except `/health` requires `Authorization: Bearer <token>` (401 first). CORS approves only the
  app's origin → doubles as anti-CSRF. Never commit a token.
- **Reuse the host's `claude` login** via the Agent SDK — no `ANTHROPIC_API_KEY`. Credential
  portability across Win/macOS/Linux is the `claude` CLI's job, not the shim's.
- **Project knowledge lives in the TARGET repo's CLAUDE.md** (loaded via `settingSources:
  ["project"]`). Keep the shim's `PREAMBLE` generic — no project specifics here.
- **The SSE event contract (README §6) and element-capture contract (README §7)** are the
  shim↔extension interface — change both sides together. New SSE `type`s are backward-compatible.
- **The element picker listens on `window` in the capture phase** and tags its own UI with
  `data-slidewrite-ui` — marking an element must never trigger the app's own handlers. Suppression
  is per-target: clicks on `data-slidewrite-ui` nodes (and bare body/html) pass through, so the
  panel stays usable while the picker is armed for consecutive picks.

## Build / run
- Shim: `cd shim && npm install`, then
  `node shim/slide-write.mjs --repo <path> --port 4040 --origin http://localhost:5173 --token <secret>`.
- Smoke test: `curl /health`, `curl -H 'Authorization: Bearer <t>' /meta`, then `POST /design`;
  expect SSE `start → file_edit → result → commit → done` and one scoped commit
  (`git reset --hard HEAD~1` to clean up). See README §12.
- **Version bump:** whenever any code under `extension/` changes, bump the patch level of the
  SemVer `version` in `extension/manifest.json` (e.g. `0.2.1` → `0.2.2`) in the same change.
- Extension: load `extension/` unpacked; in options add the app origin → `shimUrl` + token; enable.
  Non-localhost origins prompt for a runtime host permission and get a dynamically registered
  content script (README §8.1); localhost stays zero-config via the static manifest entries.
- No test framework or linter yet.

## Gotchas
- **Validated against `@anthropic-ai/claude-agent-sdk` 0.3.168** (phase-1 spike). Confirmed: message
  `type`s are lowercase `system | assistant | user | result | stream_event`; `system/init` carries
  `session_id` + `model`; assistant/user content are Anthropic blocks (`tool_use`, `tool_result`
  with `tool_use_id`); `system/thinking_tokens` and per-assistant-message `message.usage` feed the
  live `usage` SSE event (README §6 "Live token usage" — deduped by message id, thinking estimate
  reset on authoritative usage); other extra types (`system/status`, `rate_limit_event`) are
  ignored. Shapes can still drift across versions — re-verify on upgrade.
- The run logic is the exported `runDesign(body, emit, aborted, signal, repo)`; the HTTP server only starts when
  the file is run directly (`import.meta.url` guard), so it can be imported by tests.
- Run the shim as a **normal foreground/terminal process** (e.g. a dedicated VS Code terminal). It
  was validated foreground; that's the intended usage and where you want its logs anyway.
- App and shim are different ports → cross-origin → the shim sets `Access-Control-Allow-Origin` for
  the app origin. **No mixed content / no PNA prompt** when the app page is itself on `localhost`
  (loopback→loopback); the `Access-Control-Allow-Private-Network` header covers the public-hostname
  fallback.
- In remote dev, **open the app via its VS Code-forwarded `localhost` URL**, not a public hostname —
  that keeps every topology uniform (localhost↔localhost).
- The reverse-proxy/Traefik path (README §13) is a **fallback** for public-hostname access only;
  don't reach for it by default.
- One run at a time **per repo** (the shim's `busyRepos` lock; different repos may run
  concurrently in multi-host mode). The UI's `AbortController` cancels on close
  (`req.destroyed` in the shim).
