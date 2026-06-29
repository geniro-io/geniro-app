---
tier: T1.5
producer: plan
schema-version: 1
branch: main
timestamp: 2026-06-29T09:04:18Z
geniro_kind: design-doc
geniro_schema_version: m5-v1
task_slug: geniro-app-v1
topic: "Local-first macOS app (Electron + TS daemon) to compose and run a DAG of CLI coding agents"
mode: IDEA
effort_tier: big
lifecycle: approved
budget:
  max_files_to_edit: null
  max_lines_changed: null
  time_budget: null
checkpoints:
  - {step_anchor: step-1, name: "M1 — daemon boots, /health ok, onboarding passes"}
  - {step_anchor: step-2, name: "M2 — single-agent chat round-trip persisted+resumable"}
  - {step_anchor: step-3, name: "M3 — graph DAG fan-out runs end-to-end"}
  - {step_anchor: step-4, name: "M4 — terminal mirror + electron-updater + signed DMG"}
forbidden_actions:
  - "do NOT bundle a Python runtime — the whole stack is TypeScript"
  - "do NOT write API tokens/secrets into SQLite or any file — macOS Keychain only"
  - "do NOT store graph definitions in SQLite — YAML files are the source of truth; SQLite is runtime/history only"
  - "do NOT add tmux/PTY-scraping for graph execution in v1 — graph nodes run headless"
  - "do NOT add cloud/remote/multi-machine code paths — local single-machine only"
tools_required: ["node", "pnpm", "git", "claude", "cursor-agent"]
---

<!-- geniro:design-doc -->

# geniro v1 — local-first macOS app for composing and running a DAG of CLI coding agents

> Reference sources for the `file:line` citations below (read-only, for grounding — NOT files in this repo):
> Geniro monorepo at `/Users/sergeirazumovskij/Desktop/Projects/Geniro/geniro`; Omnigent clone analyzed in research; full analysis at `docs/research/geniro-vs-omnigent-analysis.md`.


## 1. Objective

Build geniro v1 — a local-first macOS app (Electron shell + a bundled TypeScript daemon) where a user composes a DAG of CLI coding agents (Claude, and Cursor via API token) on a canvas and runs them as a team through a full-screen chat, with all execution, storage, secrets, and auto-update handled locally.

## 2. Scope — Included

- macOS desktop app: Electron shell + bundled TS daemon spawned as a loopback sidecar (HTTP+WS + pidfile + token), `electron-updater` for one-artifact auto-update (`host/local_server.py:153-233`).
- Local storage split: graph definitions as YAML files (central library + import/export); settings in a config file in userData (electron-store); secrets in macOS Keychain; SQLite (`better-sqlite3`, WAL, migrate-on-launch) for runtime/history only (`db/utils.py:430-467`, `server_config.py:23`).
- Graph engine ported from Geniro core: `{nodes,edges}` schema, validation, Kahn topo-sort, registry (`graph-compiler.ts:235`, `graphs.types.ts:11-20`, `graph-registry.ts:19-294`).
- All-TS CLI-agent adapter layer: a unified `Executor` + normalized event model (`inner/executor.py:518-596`, `schemas.py:3681-3739`), driven HEADLESS (`claude -p --output-format stream-json`; `cursor-agent -p --output-format stream-json`) — see `code.claude.com/docs/en/headless`, `cursor.com/docs/cli/headless`.
- Two agents v1: Claude (subscription login or `ANTHROPIC_API_KEY`) + Cursor (`CURSOR_API_KEY`, headless).
- DAG fan-out execution: node = {agent, model, shared cwd, role/system-prompt, approval flags, opt MCP}; edge = upstream final text → downstream prompt + shared folder; parallel independent nodes + sequential chains.
- Approval model: auto-approve default + per-node "ask in UI" elicitation cards.
- Live PTY terminal mirror (`node-pty` + `xterm.js`) for ad-hoc "see the original terminal" sessions — the TS equivalent of `terminals/ws_bridge.py:455`.
- Pages: Onboarding; Workflows (list + static canvas editor ↔ YAML, port of Geniro React Flow canvas); Chats (pick a workflow → full-screen dialog, PRIMARY surface); Settings.

## 3. Scope — Excluded

- Live real-time canvas animation of a running graph (node-status highlighting) — deferred; simplify first.
- Cursor via Anthropic subscription (interactive TUI path) — deferred (needs PTY-driven TUI + store scraping).
- Other agents (Codex, Qwen, Goose, OpenCode, …), git-worktree isolation, seatbelt sandbox.
- Conditional routing, fan-in/join nodes, loops in the graph.
- Cloud/remote, multi-user, multi-machine hosts, WS tunnel.
- Persona library (system-agents), instruction-blocks, MCP-as-node, in-canvas tool manager.
- Windows/Linux (macOS only); Apple notarization may be deferred to the distribution step (dev-signed during development).

## 4. Assumptions

- macOS (Apple Silicon + Intel); the Node runtime ships inside Electron.
- `claude` and `cursor-agent` are installed on PATH; the app detects them and guides installation if missing.
- Claude auth via existing `claude login` (subscription) or `ANTHROPIC_API_KEY`; Cursor via `CURSOR_API_KEY` entered at onboarding (→ Keychain).
- Claude `stream-json` is stable/documented; Cursor's headless event schema is private/version-volatile, so it is isolated behind one defensive parser pinned to a tested `cursor-agent` version.
- The Geniro graph-engine core ports cleanly to standalone TypeScript (confirmed in Phase 1: easy core, rewrite the NestJS orchestration).

## 5. Risks

- HIGH — Cursor headless event schema is private/version-volatile → adapter breakage on Cursor updates. Mitigation: isolate behind one adapter, defensive version-tolerant parser, pin a tested version, integration test (`cursor.com/docs/cli/headless`).
- MEDIUM — headless `-p` runs with full write access → unsupervised file/shell ops. Mitigation: explicit approval/permission flags, default approval policy, cwd scoping (sandbox deferred, noted).
- MEDIUM — `node-pty` native module build across arch × Electron version. Mitigation: prebuilt binaries / `electron-rebuild`.
- MEDIUM — code-signing/notarization complexity for distribution. Mitigation: dev-signed during dev, notarize at the M4 distribution step.
- LOW — YAML↔canvas round-trip fidelity. Mitigation: `layout` block in YAML + zod validation on load.
- LOW — daemon orphan on crash. Mitigation: pidfile + `/health` + orphan-sweep on start (`host/local_server.py:153-233`).

## 6. Steps

- [ ] 1. M1 — Shell + infra: Electron + daemon-sidecar (loopback HTTP+WS + pidfile + token) + SQLite/migrations + onboarding. See `milestone-1.md`; grounded in `host/local_server.py:437-672`, `db/utils.py:430-467`. <!-- step-1 -->
- [ ] 2. M2 — One agent in chat (headless): `Executor` + event model + Claude/Cursor headless adapters + Chats single-agent dialog. See `milestone-2.md`; grounded in `inner/executor.py:518-596`, `schemas.py:3681-3739`. <!-- step-2 -->
- [ ] 3. M3 — Graph + execution: port Geniro graph core + canvas editor ↔ YAML + DAG fan-out executor + approvals. See `milestone-3.md`; grounded in `graph-compiler.ts:235`, `graphs.types.ts:11-20`. <!-- step-3 -->
- [ ] 4. M4 — Terminal mirror + auto-update + packaging: `node-pty`/`xterm` + Settings + `electron-updater` + signed DMG. See `milestone-4.md`; grounded in `terminals/ws_bridge.py:455`. <!-- step-4 -->

## 7. Tools Required

- `node` + `pnpm` (monorepo), `git`.
- Electron · electron-builder · electron-updater.
- `@xyflow/react` · `elkjs` · React 19 · Vite · zustand (UI, ported from Geniro web).
- `better-sqlite3` · `drizzle-kit` (migrations) · `js-yaml` · `zod`.
- `node-pty` · `xterm.js` · `keytar` (or Electron `safeStorage`).
- External CLIs on PATH: `claude`, `cursor-agent`.

## 8. Approval Points

- Before installing each new dependency group (Electron, node-pty, better-sqlite3, @xyflow/react, …) — confirm. <!-- step-1 -->
- Before pinning the tested `cursor-agent` version for the defensive parser. <!-- step-2 -->
- Before configuring the signing identity / notarization. <!-- step-4 -->
- A demo checkpoint at the end of each milestone (M1–M4) before proceeding.

## 9. Validation

- M1: daemon starts, `GET /health` returns 200, the Electron window connects, onboarding completes (folder + Cursor key → Keychain + CLI detection). verify: curl -fsS http://127.0.0.1:<port>/health
- M2: full chat round-trip with one agent (Claude and Cursor), messages persisted to SQLite, reconnect after window restart.
- M3: a 2–3 node graph executes (topo-sort + fan-out), node A's output reaches node B, edits visible in the shared folder; approvals (auto + ask) work.
- M4: live terminal works; `electron-updater` installs a new version; a signed DMG builds.
- Tests: per-adapter NDJSON-parsing unit tests; graph-compiler tests ported from Geniro; a Cursor integration test pinned to a known `cursor-agent` version.

## 10. Rollback-Recovery

- Greenfield → rollback = `git revert` per milestone branch (each Mn on its own branch).
- Daemon crash → orphan/pidfile cleanup on start + resume a run from SQLite (node statuses persisted).
- Migrations → back up `geniro.db` before a schema upgrade.
- Auto-update → `electron-updater` retains the previous version for rollback.

## 11. Done Condition

geniro v1 ships when: the app launches and auto-updates; the daemon auto-starts; onboarding works; a graph is composed on the canvas and saved as YAML; in Chats a full-screen dialog runs a workflow where Claude and Cursor execute as a DAG fan-out in a shared folder with results passed along edges; approvals work; secrets live in Keychain; and a signed DMG is produced.

## Considered Alternatives

### Daemon in Electron main (rejected)
Trade-off: simplest (one process), but heavy stream-parsing/agent IO on the main process can stall the UI thread, the engine can't be reused headless/as a CLI, and reconnect-to-run after a window reload is harder.

### Daemon in Electron utilityProcess (rejected)
Trade-off: off the main thread and Electron-managed, but hard-tied to the Electron lifecycle (dies with the app — not a persistent background service) and MessagePort IPC is less portable than loopback WS.

## Milestones

- `milestone-1.md` — Shell + infra (Electron, daemon-sidecar, SQLite, onboarding).
- `milestone-2.md` — One agent in chat (Executor + event model + Claude/Cursor headless adapters + Chats).
- `milestone-3.md` — Graph + execution (port Geniro core, canvas editor ↔ YAML, DAG fan-out executor, approvals).
- `milestone-4.md` — Terminal mirror + auto-update + packaging (node-pty/xterm, Settings, electron-updater, signed DMG).
