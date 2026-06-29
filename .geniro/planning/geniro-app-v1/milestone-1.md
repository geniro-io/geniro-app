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
parent_spec: geniro-app-v1
---

<!-- geniro:design-doc -->

# geniro v1 · Milestone 1 — Shell + infrastructure

> Reference sources for the `file:line` citations below (read-only, for grounding — NOT files in this repo):
> Geniro monorepo at `/Users/sergeirazumovskij/Desktop/Projects/Geniro/geniro`; Omnigent clone analyzed in research; full analysis at `docs/research/geniro-vs-omnigent-analysis.md`.


## 1. Objective

Stand up the macOS app skeleton: an Electron shell that spawns and supervises a bundled TypeScript daemon over loopback, with a local SQLite store and a first-run onboarding flow.

## 2. Scope — Included

- Monorepo scaffold (pnpm): `apps/shell` (Electron main + React renderer), `packages/daemon` (TS), shared types.
- Electron main: `app.whenReady` → spawn daemon child → wait for `/health` → load renderer (`host/local_server.py:437-520`).
- Daemon sidecar: loopback HTTP+WS server (Fastify/`ws`) on a preferred port with free-port fallback; write `daemon.pid` (PID+port) + a bearer token; `/health` endpoint (`host/local_server.py:153-233`).
- SQLite via `better-sqlite3` (WAL + busy_timeout); migrate-on-first-launch with a head-check (`db/utils.py:224-249,430-467`); initial schema: `runs`, `items`, `node_state`, plus a `settings` config file in userData (electron-store).
- Onboarding screen: pick project folder; enter `CURSOR_API_KEY` → Keychain (`keytar`/`safeStorage`); detect `claude`/`cursor-agent` on PATH with install guidance.
- Window↔daemon transport: renderer connects to the daemon WS using the on-disk port+token; reconnect logic.

## 3. Scope — Excluded

- No agents, no graph, no chat yet (M2/M3).
- No PTY terminal, no auto-update, no packaging (M4).

## 4. Assumptions

- macOS; Node bundled in Electron.
- Keychain access available; userData path writable.

## 5. Risks

- MEDIUM — daemon spawn/port/token handshake races. Mitigation: pidfile written only after `/health` ok + sig sidecar ordering (`host/local_server.py:200-233`).
- LOW — better-sqlite3 native build under Electron. Mitigation: electron-rebuild/prebuilds.

## 6. Steps

- [ ] 1. Scaffold pnpm monorepo: `apps/shell`, `packages/daemon`, shared `packages/types` (mirror Geniro layout `package.json`, `pnpm-workspace.yaml`). <!-- step-1 -->
- [ ] 2. Implement the daemon loopback server + `/health` + pidfile(PID+port)+token (`host/local_server.py:153-233`). <!-- step-2 -->
- [ ] 3. SQLite store: `better-sqlite3` WAL + drizzle migrate-on-launch head-check; tables `runs`/`items`/`node_state` (`db/utils.py:430-467`). <!-- step-3 -->
- [ ] 4. Settings config file in userData via electron-store; Keychain wrapper via `keytar`/`safeStorage`. <!-- step-4 -->
- [ ] 5. Electron main: spawn+supervise daemon, wait for `/health`, load renderer; teardown on quit (`host/local_server.py:437-520`). <!-- step-5 -->
- [ ] 6. Onboarding screen: folder picker + Cursor key→Keychain + `claude`/`cursor-agent` PATH detection. <!-- step-6 -->

## 7. Tools Required

- `node`, `pnpm`, Electron, electron-builder (dev), `better-sqlite3`, `drizzle-kit`, electron-store, `keytar`.

## 8. Approval Points

- Before installing the dependency set (Electron, better-sqlite3, keytar) — confirm. <!-- step-1 -->
- Demo checkpoint at M1 end.

## 9. Validation

- Launch app → daemon process starts → `GET /health` returns 200 → renderer connects. verify: curl -fsS http://127.0.0.1:<port>/health
- Onboarding: pick a folder, enter a Cursor key (stored in Keychain, not on disk), CLIs detected; relaunch reuses the running daemon via pidfile.

## 10. Rollback-Recovery

- `git revert` the M1 branch. Daemon is stateless beyond `geniro.db`; deleting `geniro.db` + pidfile resets cleanly.

## 11. Done Condition

- The app launches, auto-starts its daemon, passes onboarding, and the renderer is connected to the daemon over loopback with a working SQLite store.
