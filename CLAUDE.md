# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**geniro-app** is a **local-first macOS desktop app** for composing and running a **DAG of CLI coding agents** as a team. It is a from-scratch rewrite of Geniro that marries Geniro's graph engine with a local-first, CLI-agent execution layer — **everything runs on the user's machine, no cloud**.

The app is an **Electron UI** that also supervises a **bundled local daemon** over loopback. The daemon is an `apps/api`-style **NestJS** app built on packages **vendored from the Geniro monorepo** and adapted for local-first use (SQLite instead of Postgres, no Sentry/Redis/cloud, loopback-only).

**Tech stack**: TypeScript 6.x, Node.js 24+, NestJS 11 (Fastify), MikroORM (`@mikro-orm/sqlite` / better-sqlite3), React 19 + Tailwind CSS v4 (electron-vite renderer), pnpm 11 + Turbo 2.10 monorepo, swc (daemon + packages) / electron-vite (UI), Vitest 4, ESLint 10 + Prettier 3.

**Status**: **All four v1 milestones are built** — M1 (UI + infrastructure), M2 (single-agent chat via CLI adapters), M3 (workflow graphs + DAG fan-out execution), M4 (live PTY terminal mirror, Settings, update notifier, macOS packaging). The plan and milestones live in `.geniro/planning/geniro-app-v1/` (`spec.md` + `milestone-1..4.md`) — this is the authoritative source for scope and sequencing. (`.geniro/planning/` is local working state, gitignored — not committed.)

**Agents (M2+)** are driven **headlessly via their CLIs only** — `claude -p` and `cursor-agent -p --output-format stream-json`. No SDKs, no LangGraph host-side, no Python.

---

## CodeGraph — prefer it over grep/find

This repo is indexed by **CodeGraph** (a `.codegraph/` directory exists at the repo root — it is gitignored and **not committed**, but it is always present locally and must be kept in use). When you need to understand or locate code, reach for CodeGraph **before** grep/find or opening files:

- **MCP tool** (preferred): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim, line-numbered source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current source.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

Fall back to grep/Glob/Read only when CodeGraph has no answer (e.g. non-code files, brand-new code not yet indexed).

---

## Commands

All commands run from the **repo root** unless noted. **Always run `pnpm install` first** to ensure dependencies are present.

### Daily development
```bash
pnpm install            # install workspace deps
pnpm rebuild:native     # rebuild better-sqlite3 against Electron's ABI (required; see note)
pnpm build              # build everything (turbo → swc for packages+daemon, electron-vite for the UI)
pnpm dev                # launch the Electron app (electron-vite) — spawns + supervises the daemon
pnpm daemon:dev         # daemon-only watch loop: runs TS source via @swc-node/register under Electron-node, restarts on save
```

`pnpm rebuild:native` is required because the daemon runs under Electron's bundled Node (`ELECTRON_RUN_AS_NODE`), so its native `better-sqlite3` must be built for Electron's ABI, not the host Node ABI.

`pnpm daemon:dev` mirrors Geniro `apps/api`'s `start:dev`: node's built-in `--watch` + `-r @swc-node/register -r tsconfig-paths/register` running `src/main.ts` directly (`TS_NODE_PROJECT` points at the **root** tsconfig so the inherited `@packages/*` paths resolve from the repo root). No build step and no `dist/` in dev — `@packages/*` resolve to TypeScript **source**, so edits to `apps/daemon/src` *and* `packages/*/src` restart the daemon (~2s) with fresh code. Two deliberate deviations from Geniro's line: the runtime is `ELECTRON_RUN_AS_NODE=1 electron` (host Node's ABI can't load the Electron-built `better-sqlite3`), and there is no `--watch-kill-signal=SIGKILL` (default SIGTERM lets Nest shutdown hooks run — pidfile cleanup + `ProcessRegistry` reaping of spawned agent children). It must **not** be moved to `tsx`/esbuild: esbuild's `emitDecoratorMetadata` is an intentional wontfix (no type system → no `design:paramtypes`), so NestJS type-based DI cannot resolve under it.

### Build, types, lint
```bash
pnpm build              # turbo run build (swc → dist/ for packages & daemon; electron-vite → out/ for the UI)
pnpm check-types        # turbo run check-types (tsc --noEmit per package — swc does NOT type-check)
pnpm lint               # eslint, no fixes
pnpm lint:fix           # eslint + prettier auto-fix
```

### Testing
Always use the package.json scripts — never call `vitest` directly.
```bash
pnpm test:unit                       # all unit tests (vitest, *.spec.{ts,tsx})
pnpm --filter @geniro/daemon test:unit     # just the daemon
pnpm --filter @geniro/ui test:unit         # the UI
```

### Before finishing any work
```bash
pnpm full-check         # must pass before finishing
```

`full-check` chains build → check-types → build:tests → lint:fix → test:unit → test:integration. `build:tests` and `test:integration` are **no-op placeholders today** — declared in `turbo.json` (so turbo 2.10 doesn't error on them) but no package implements them yet and no `*.int.ts` exist — so it effectively gates build + types + lint + unit tests until integration tests land.

### Packaging (macOS)
```bash
pnpm --filter @geniro/ui build:mac   # scripts/build-mac.mjs → DMG + zip into release/dist/
```

### Dependency upgrades & commits
```bash
pnpm upgrade            # bump every workspace dep to latest (ncu, peer-aware via .ncurc) + reinstall
pnpm commit             # conventional commit via commitizen
```

> Database: the daemon **syncs the SQLite schema additively on launch** (`orm.schema.update({ safe: true })` in `main.ts` — never destructive). There is still **no Migrator / migration files**: `db/mikro-orm.config.ts` declares no `migrations` key, and the versioned migration workflow remains deferred past v1. Do not hand-write migrations.

---

## Architecture

A **pnpm + Turbo monorepo** whose root config and server packages are **cloned from the Geniro monorepo** and adapted for local-first use.

```
apps/
  ui/               @geniro/ui       — Electron main + preload + React renderer (electron-vite)
  daemon/           @geniro/daemon   — NestJS loopback daemon (apps/api-style) over @packages/http-server + mikro-orm SQLite
packages/
  common/           @packages/common — AppBootstrapper, pino logger, exceptions (vendored from Geniro; Sentry removed)
  http-server/      @packages/http-server — NestJS + Fastify host: health, swagger/scalar, helmet, validation, jose (vendored; OIDC auth dormant; + loopback listen opts host/portFallback/onListening)
  metrics/          @packages/metrics — Prometheus metrics (vendored from Geniro)
  mikroorm/         @packages/mikroorm — TimestampsEntity base, BaseDao, MikroOrmModule (vendored; driver swapped to @mikro-orm/sqlite)
```

### The daemon (`apps/daemon`)
A standalone NestJS engine the UI spawns as a child process, laid out like Geniro's `apps/api/src`: `main.ts` (bootstrapper + extensions → `init()`) and `app.module.ts` at the root, then feature/infra dirs:
- `auth/` — `runtime.ts` (per-launch `RuntimeInfo` + DI token, incl. the bound `port`) + global `runtime.module.ts` (also hosts `CallTokenRegistry`, so the guard and the graph executor share it without a module cycle); `mint-token.ts` (the one source of loopback credentials — the launch token AND the per-caller-node MCP call tokens); `token.guard.ts` + `safe-equal.ts` (loopback bearer-token gate); `ws-auth.ts` (`enforceWsHandshakeAuth` — the ONE Socket.IO handshake gate, shared by every gateway, since engine.io bypasses Nest guards); `call-token.registry.ts` (per-`(runId, nodeId)` MCP call tokens).
- `environments/` — `environment.{prod,dev,test}.ts` + `index.ts` (picks by `NODE_ENV`, loads `.env` via dotenv).
- `utils/` — `handshake.ts` (pidfile `DaemonInfo` shape + loopback bind defaults + `isValidPort`/`parsePort`); `pidfile.ts` (write/remove — `mintToken` moved to `auth/mint-token.ts`); `pidfile.lifecycle.ts` (Nest `OnApplicationShutdown` → removes the pidfile).
- `db/mikro-orm.config.ts`.
- `v1/runs/` — `runs.module.ts` + `entity/{run,item,node-state}.entity.ts` + `runs.types.ts` (status/kind enums).
- `v1/agents/` — the shared agent-execution substrate (M2): `agents.module.ts` + `chat.types.ts` at the root, then `adapters/` (abstract `AgentAdapter` base + `claude/` and `cursor/` subdirectories — see `.claude/rules/agent-adapters.md`; `claude/question-payload` — defensive projections over an AskUserQuestion input: question text, option labels, and `withResponse` — the probe-verified `updatedInput.response` free-text answer channel), `controllers/`, `services/` (chat service, event bus, process registry, approval registry; `skills` — the on-disk skills/slash-commands scan (`.claude/skills` + `.claude/commands` / `.cursor/commands`, project + `~`) behind the composer's `/` autocomplete, merged with `skill-harvest` — the per-cwd `slash_commands` lists claude's own `system/init` events report as turns run (built-ins + plugin skills the scan can't see, `source: 'cli'`; cached in `<userData>/claude-skills.json`); `cursor-mcp-merge` — the `.cursor/mcp.json` merge lifecycle around cursor CALLER turns: per-cwd `KeyedMutex` with a 30s wait→degrade, journal-first writes to `<userData>/cursor-mcp-journal.json`, backup + surgical restore, `reconcileStranded()` called from `main.ts` at boot beside the claude config sweep), `dao/`, `dto/`, `utils/` (json-util, ndjson-buffer, spawn-cli, event-to-item, resolve-cwd, skill-markdown; M3 adds `agent-version` — `--version` probe-cache key; `child-handle` — wraps short-lived utility children as registrable handles; `keyed-mutex`; `cursor-mcp-entry` — the ONE `geniro` server-entry shape both the probe and real turns get, `autoApprove` bounded to our own tool names (never `--approve-mcps`); `cursor-mcp-file` — merge/backup/surgical-restore, refuses unparseable files, foreign `geniro` keys, and non-object `mcpServers`, chmods the token-bearing file 0600 for the turn and restores the original mode; `cursor-mcp-journal`; `cursor-mcp-enable` — best-effort `cursor-agent mcp enable geniro`). Exported to the graphs module (event bus, registries, DAOs, adapters, the merge service).
- `v1/graphs/` — the M3 workflow module + the agent-to-agent **call runtime**: `graphs.module.ts` + `graphs.types.ts` (zod Workflow/node/edge/layout schemas + the call-runtime contract: `CallMode`/`CallEnvelope` (incl. the M4 `question` arm)/`CalleeTurnOutcome`/`RunCallCapability`/`ParkQuestionInput`) at the root, then `utils/` (ported graph validation + Kahn topo order incl. `onDemandNodeIds` — the one call-only-node predicate shared by validation and execution; comment-preserving `workflow-yaml`; `turn-semaphore` — the callee sub-turn slot pool; `role-text` — role flattening for prompts/tool descriptions), `services/` (`workflow-store` — the `*.geniro.yaml` library under `<userData>/workflows/`; `graph-executor` — the DAG fan-out over the M2 adapters, plus on-demand call-only callees, the per-run call surface, and per-caller-node MCP tokens; `call-broker` — call ids, depth/turn caps, sync/async+`await_agent`/fire-and-forget, the status envelope, and the M4 parked-question lifecycle (park → `answer_agent` / 5-min TTL → `QUESTION_TIMEOUT` / caller-settle drain → `QUESTION_ORPHANED`; a parked sync call becomes await-collectable); `mcp-server` — the stateless per-request MCP JSON-RPC host via `@modelcontextprotocol/sdk`, tools list/dispatch (`call_agent`/`await_agent`/`answer_agent`) + in-protocol error mapping, plus a probe-only `echo` tool for live probe run ids; `cursor-probe` — the one-time cursor-agent MCP-trust probe (M3): one real headless turn in a daemon-owned temp cwd against the echo tool, verdict = a server-side `tools/call` observation, cached per `cursor-agent --version` in `<userData>/cursor-probe.json` (environmental failures — timeout, spawn error — stay memory-only), retries once without `--trust` on older CLIs), `controllers/` (`workflows` + `mcp` + `capabilities` — thin routes delegating to `mcp-server` / `cursor-probe`), `dto/`. The **call runtime** replaced M1's run-start `GRAPH_CALL_RUNTIME_UNAVAILABLE` guard: a claude caller node gets `call_agent`/`await_agent` over a loopback MCP endpoint delivered as a per-turn `--mcp-config` file (the token rides the 0600 file, never argv). **Cursor callers (M3)** are probe-gated: one `callCapable` predicate in the executor drives every admission surface (endpoint grant, token minting, awareness block, run-start self-check); on a probe pass the endpoint reaches cursor via a per-turn merge of a `geniro` entry into the run cwd's `.cursor/mcp.json` (the `cursor-mcp-merge` service — acquired before spawn, restored on settle, boot-reconciled after a crash, git-tracked warning), and on fail/unknown the caller degrades VISIBLY (builder card warning via `GET /v1/capabilities` + a run-time system item) — never silently. **The Q&A bridge (M4)**: a call-initiated callee's AskUserQuestion parks in the broker and returns to the CALLER as a `{status:'question', call_id, question, options}` envelope — the caller answers via `answer_agent(call_id, answer)` (delivered as `control_response` with `updatedInput.response`) or escalates to the user through its own question card, then collects the final result with `await_agent`. Because headless claude strips AskUserQuestion under `--dangerously-skip-permissions` (probe-verified on 2.1.202), question-capable claude turns — call-initiated callees AND caller nodes — spawn in the CLI's ask mode with the DAEMON auto-approving plain permission requests at the executor seam (unattended semantics preserved; an explicit `approval: 'ask'` node keeps the human card for permissions); the `requires_user_interaction` flag + tool name discriminate questions from permissions, and DAG-scheduled questions keep today's card path (now genuinely answerable: the WS `verdict` payload carries an optional `answer` that rides `updatedInput.response`). Transcript kinds `call_question`/`call_answer` record the exchange under the caller's node. Accepted M3 limitations: `cursor-agent mcp enable geniro` leaves a name-scoped approval in cursor's own trust store past the run (inert once the entry is removed; not disabled on restore so a future run's enable isn't blocked), and during a cursor→cursor call in the one shared run cwd the callee can see the caller's merged entry/token — which since M4 also lets that callee self-answer its own parked question via `answer_agent` (same trust domain, bounded by the depth/turn caps).
- `v1/notifications/` — `notifications.module.ts` + `gateways/notifications.gateway.ts` (the Socket.IO channel: run rooms + the approval `verdict` round-trip; the verdict optionally carries an `answer` string for question cards — M4).
- `v1/terminals/` — the M4 live PTY terminal mirror: `terminals.module.ts` + `terminals.types.ts` at the root, then `services/` (`pty.service` — node-pty sessions registered with the shared `ProcessRegistry` under `terminal:<id>`, scrollback replay buffer, SIGHUP→group-SIGKILL escalation, exited-session TTL; `terminals.service` — resolves a run/node to a `claude --resume <agentSessionId>` spawn via the stored `node_state` session id), `gateways/terminals.gateway.ts` (the `/terminals` Socket.IO namespace on the SAME `/ws` engine.io instance — attach/replay, input, resize, detach), `controllers/`, `dto/`, `utils/` (`terminal-command` — cursor-agent is rejected, deferred scope). Sessions are ephemeral (in-memory only — a live mirror is not history).

- Binds **`127.0.0.1` only**. Assembled exactly like Geniro's `apps/api` (`buildBootstrapper(…)` → `addExtension(buildHttpServerExtension(…))` → `init()`); the loopback specifics ride on the extension's `host` / `portFallback` / `onListening` options — bind 127.0.0.1, negotiate a free port if the preferred one is taken, and write the pidfile from `onListening` after a healthy listen (the `http-server`'s own listen still defaults to `0.0.0.0`, preserving Geniro's behavior). Shutdown is Nest-owned (`enableShutdownHooks`); `utils/pidfile.lifecycle.ts` clears the pidfile on the way out, so `main.ts` needs no signal handling.
- Writes the pidfile (`daemon.json`: `pid`, `host`, `port`, per-launch `token`, `version`, `startedAt`) **only after** the schema is synced and the server is listening, then prints `GENIRO_DAEMON_READY {port}` to stdout. The UI never assumes the host/port — it reads the bound values back from the pidfile (so it no longer passes `GENIRO_PORT`; the daemon owns that default).
- Config env (set by the UI): `GENIRO_USER_DATA` (userData dir; fallback `~/.geniro`) and `GENIRO_PORT` (preferred port; default `47615` per `DAEMON_PREFERRED_PORT` in `utils/handshake.ts`, falling back to a free port if taken). DB is `geniro.db`, pidfile `daemon.json`, both in the userData dir.

### Daemon endpoints (loopback)
| Route | Purpose | Auth |
|---|---|---|
| `GET /health/check` | readiness probe (`{status, version}`) | public |
| `GET /metrics` | Prometheus metrics | bearer token (`LoopbackTokenGuard`) |
| `GET /swagger-api` · `/swagger-api/reference` | OpenAPI spec + Scalar UI | bearer token (`LoopbackTokenGuard`) |
| `/ws` (Socket.IO) | renderer ⇄ daemon channel: `join`/`leave` run rooms, streamed `item` events, approval `verdict` → `verdict_ack` | per-launch token (handshake `auth`) |
| `POST/GET /v1/chats*` | single-agent chats: create/list, `:runId/items` history (`afterSeq` cursor, shared by workflow runs), `:runId/messages`, `:runId/cancel` | bearer token (`LoopbackTokenGuard`) |
| `GET /v1/agents/skills` | skills + slash commands one agent kind accepts in a given cwd (on-disk scan, project + `~`, merged with the claude session's own harvested `slash_commands` report) — feeds the composer's `/` autocomplete | bearer token (`LoopbackTokenGuard`) |
| `/v1/workflows*` | workflow library CRUD (`GET/POST /`, `GET/PUT/DELETE /:slug`, `POST /import`, `POST /:slug/export`) + runs (`POST /:slug/runs`, `GET /runs`, `GET /runs/:runId/nodes`, `POST /runs/:runId/cancel`) | bearer token (`LoopbackTokenGuard`) |
| `/v1/terminals*` | PTY mirror sessions: `POST /` (open for a run/node), `GET /`, `GET /:id`, `DELETE /:id` (kill) | bearer token (`LoopbackTokenGuard`) |
| `POST /v1/mcp/:runId/:nodeId` | the agent-to-agent call runtime: a stateless MCP JSON-RPC endpoint (`initialize` / `tools/list` / `tools/call` for `call_agent` + `await_agent` + `answer_agent`; a live probe run id is served a single `echo` tool instead) scoped to one run's one caller node | that caller node's **per-node call token** OR the launch token (`LoopbackTokenGuard`) |
| `GET /v1/capabilities` | machine capabilities for the builder: the cursor agent-calls probe verdict (`{cursorCalls}`); reading pre-warms the probe when unprobed | bearer token (`LoopbackTokenGuard`) |
| `/terminals` (Socket.IO namespace on `/ws`) | PTY byte plane: `attach` (scrollback replay), `input`, `resize`, `detach`; emits `terminal_data` / `terminal_exit` to `terminal:<id>` rooms | per-launch token (handshake `auth`, same gate as `/ws`) |

The public allowlist is **`/health` alone** (`PUBLIC_PREFIXES` in `auth/token.guard.ts`), matched at segment boundaries so a sibling route like `/health-debug` doesn't inherit it. `/metrics` and `/swagger-api` are **token-gated**: with a deterministic default port, any web page could otherwise read the daemon's Prometheus internals and full API schema cross-origin. Every non-allowlisted route requires the `Bearer <token>` header — the launch token, or, **only** on `/v1/mcp/<runId>/<nodeId>`, that caller node's own per-node call token (minted when the run starts, revoked when it settles, keyed by `(runId, nodeId)` so one callee child can't open another node's route). The WS channel is a NestJS Socket.IO gateway (`@WebSocketGateway({ path: '/ws' })`) installed via the `IoAdapter` in `main.ts`; the renderer (`socket.io-client`) sends the per-launch token in the Socket.IO handshake `auth` payload (browsers can't set headers on a WS handshake). The HTTP `LoopbackTokenGuard` doesn't see Socket.IO traffic (engine.io intercepts `/ws` before Nest routing), so each gateway owns its own WS auth — via the one shared `auth/ws-auth.ts` → `enforceWsHandshakeAuth` (constant-time `safeEqual`, disconnects on mismatch), called from `handleConnection` in **both** the notifications and terminals gateways. It is extracted precisely so a hardening fix can't silently miss a mirrored copy.

### The UI (`apps/ui`)
electron-vite project. `src/main/` — `index.ts` (app lifecycle), `daemon-supervisor.ts` (spawn/adopt/health-poll/orphan-sweep), `daemon-pidfile.ts` (reads + validates the daemon's pidfile), `settings.ts` (`settings.json`), `keychain.ts` (`@napi-rs/keyring`), `cli-detect.ts`, `ipc.ts`, `updater.ts` (notify-only update check: polls GitHub Releases and points at `brew upgrade`, never self-updates; dev no-op, launch check gated by settings), `login-shell-path.ts` (packaged Finder launches inherit launchd's minimal PATH — resolve the login-shell PATH for the daemon). `src/shared/contracts.ts` holds the IPC/Settings/CLI/Keychain/Terminal contracts + `DaemonHandle`, shared across main/preload/renderer. `src/preload/index.ts` exposes a typed `window.geniro` via `contextBridge`. `src/renderer/` — React app (`App.tsx`, `onboarding/`, `chats/` incl. `approval-card` + the composer's `/` skill autocomplete (`skill-menu`), `graphs/` React Flow canvas, `settings/`, `terminals/` xterm.js mirror panel, `daemon-rest.ts` shared REST transport + `chat-api.ts`/`workflow-api.ts`/`terminal-api.ts` clients, `daemon-client.ts` + `terminal-client.ts` WS clients).

**macOS packaging (M4)**: `pnpm --filter @geniro/ui build:mac` runs `scripts/build-mac.mjs` — two self-contained `pnpm deploy --prod --legacy` stagings (shell app + daemon under `Resources/daemon`), Electron-ABI rebuild of better-sqlite3 in the daemon staging (node-pty ships an N-API prebuild and deliberately stays OUT of `rebuild:native`), `.icns` generated from `resources/icon.png`, ad-hoc (unsigned) signing — no Developer ID, no notarization, no `publish` feed; the Homebrew cask + install script strip the quarantine bit so the ad-hoc app launches, and the app is notify-only (points at `brew upgrade`), DMG + zip into `release/dist/`. The packaged app presents as **"Geniro"** on every macOS surface (menu bar, Dock, About, Finder) via electron-builder `productName`.

`DaemonSupervisor.start()` reuses a still-healthy daemon left by a prior UI instance (pid + `/health/check` match), sweeps stale pidfiles, and only tears down the process it owns.

### Design system (renderer) — tokens + shared components

The renderer is styled with **Tailwind CSS v4 (CSS-first `@theme`)** over a **token layer that is kept in lockstep with the sibling Geniro web app** — same warm cream/caramel palette, same shadcn/ui semantic-token vocabulary — so the desktop app and Geniro web look identical. Its structure is **authoritative**; every new screen builds from it rather than reinventing styles.

```
apps/ui/src/renderer/
  styles/global.css        — the ONLY source of design tokens (:root + @theme inline) + base typography.
                             All colours/radii/shadows live here; components never hardcode them.
  components/
    ui/                    — token-driven primitives, shadcn-v4 flavour (data-slot, cva variants):
                             utils.ts (cn), button, input, textarea, select, label, card, badge.
    logo, status-dot, field, note-box, error-text, empty-state, collapsible-card
                           — app-level shared components composed from the primitives.
  chats/message-bubble.tsx — the transcript-row component (cva variants per item kind).
```

**Hard rules (mechanized in `.claude/rules/renderer-design-system.md` + `.claude/rules/renderer-components.md`, enforced where possible by the eslint override scoped to `apps/ui/src/renderer/**`):**
- **Never hardcode a colour.** Read every colour/radius/shadow from a token in `styles/global.css` — as a utility (`bg-primary`, `text-muted-foreground`, `border-border`, `shadow-panel-sm`) or `var(--token)`. A raw hex/`rgb()`/`hsl()` — including inside a Tailwind arbitrary value like `bg-[#…]` — is an eslint error. Non-colour arbitrary values (`ring-[3px]`, `size-[26px]`, `shadow-[…var(--border)]`) are fine.
- **Never duplicate a component or pattern.** Before adding UI, reach for an existing primitive in `components/ui/` or shared component in `components/`; if a pattern (a button, a field, a status dot, a card, an error line, an empty state) recurs, it lives in a shared component and is imported everywhere — never re-implemented inline.
- **New styled elements go through the layers**: a token in `global.css` → a primitive in `components/ui/` → an app component in `components/`. Compose with the `cn()` helper and, for variants, `cva`. Import directly (`./ui/button`), **no barrels**.
- **Adding a token** (a new colour/shadow) means adding it in `global.css` (`:root` + `@theme inline`) once, then referencing it — never inlining the literal at the call site.
- The palette tracks `geniro/apps/web/src/styles/global.css`; keep token names/values aligned so fixes flow between the repos (same spirit as the vendored `@packages/*`).

### Build toolchain
- **swc** compiles the daemon and all `packages/*` to **CommonJS** (`dist/`), with decorator metadata (`legacyDecorator` + `decoratorMetadata`) — entities and Nest DI rely on it. All share one root `.swcrc` (each build script references it via `--config-file ../../.swcrc`).
- **electron-vite** builds the UI (`out/`).
- Internal `@packages/*` imports resolve to **TypeScript source** via the root tsconfig path alias (`@packages/* → packages/*/src`), so the packages ship **no `.d.ts`**. Type-checking is a separate `tsc --noEmit` (`pnpm check-types`), independent of the swc build.

### Storage split
- **Graph definitions → YAML** (M3) — the source of truth; never stored in SQLite.
- **Settings → `settings.json`** in the Electron userData dir.
- **Secrets → macOS Keychain only** (`@napi-rs/keyring`) — never SQLite, never a config file.
- **SQLite (`geniro.db`) → runtime/history only** — `runs` / `items` / `node_state` rows.
- **Persist-then-emit** for streamed-then-replayable data (chat `items` and graph-node items alike): allocate the monotonic `seq`, write the row, **then** publish on the RxJS bus / per-run Socket.IO room. SQLite is the source of truth and a reconnecting client replays via an `afterSeq` cursor, so nothing is emitted before it is durable.
- The per-launch loopback **token on disk** (in `daemon.json`) is allowed — it is a local session token, not a user secret.

---

## Coding conventions

- **No `any`** — use specific types, generics, or `unknown` + type guards.
- **All imports at the top** of the file.
- **Naming**: PascalCase for classes/interfaces/enums/types; camelCase for variables/functions.
- **Errors**: throw the custom exceptions from `@packages/common` (e.g. `NotFoundException`, `BadRequestException`). Never swallow errors silently.
- **Shared packages** are aliased as `@packages/*` (e.g. `import { … } from '@packages/common'`), resolving to each package's `src`.
- **Entities** use `@mikro-orm/decorators/legacy` decorators, extend `TimestampsEntity` from `@packages/mikroorm`, and declare **explicit column types** (`@PrimaryKey({ type: 'string' })`, `@Property({ type: 'integer' | 'text' | … })`) — MikroORM's discovery needs them under swc.
- **New daemon feature modules** follow the layered structure as they're added: Controller (route + delegation only — ALL business logic in services, a controller file holds exactly one `@Controller` class with no module-scope functions) → Service (business logic) → DAO (extends `BaseDao`, injects `EntityManager` from `@mikro-orm/sqlite`) → Entity. Use Zod DTOs via `createZodDto()` from `nestjs-zod` for HTTP input. Module-shared types/interfaces are declared in the module's root types file (`<name>.types.ts`), never inline in a service/controller file.
- **Daemon module directory layout** (mechanized in `.claude/rules/daemon-module-structure.md`): a module keeps only `<name>.module.ts` + its types file at the root; every other file lives in its kind-directory — `controllers/`, `services/`, `dao/`, `entity/`, `dto/`, `utils/`, `adapters/`, `gateways/` — with specs co-located. Never a flat module.
- **CLI agent adapters** (mechanized in `.claude/rules/agent-adapters.md`): every adapter extends the abstract `AgentAdapter` base (`v1/agents/adapters/agent-adapter.ts`) and lives in its own `adapters/<name>/` subdirectory with all of its classes/types/specs; shared contract types live in `adapters/adapter.types.ts`.
- **Renderer UI follows the design system** (see *Design system (renderer)* above; mechanized in `.claude/rules/renderer-design-system.md` + `.claude/rules/renderer-components.md`): colours come from tokens in `styles/global.css` only (never hardcoded), and reusable UI is a shared component in `components/ui/` or `components/` (never duplicated inline). Prefer an existing component; promote a recurring pattern into one.

---

## Testing conventions

- **Vitest**, transformed by **swc** (`vitest.base.ts` — `unplugin-swc` + `tsconfigPaths`). Tests run from source; no build step needed.
- **Unit tests** are co-located as `*.spec.{ts,tsx}` next to the source. Run with `pnpm test:unit`, or target one workspace with `pnpm --filter <name> test:unit`. **Never** call `vitest` directly.
- **React component tests** (UI renderer) must put `// @vitest-environment jsdom` on line 1 — the default project environment is `node`. When a `vi.mock(...)` factory closes over module-scope spies, wrap them in `vi.hoisted(() => ({ … }))`.
- **Must-fail policy**: tests never conditionally skip on missing env/services — a missing prerequisite must fail loudly, not `it.skip`.
- **No flaky tests**: nondeterminism is a bug to fix at the source, not retry around. When any pre-existing problem (failing test, broken local step, latent bug) surfaces mid-task, surface it and propose a fix — never silently skip it.
- **No false pins** (mechanized in `.claude/rules/testing.md`): a test whose name or comment claims to pin a behavior must FAIL when that behavior is reverted; assert the real observable, never a proxy the test itself fabricated; and a defensive branch worth writing is worth a test that enters it.

---

## Constraints (local-first & security)

These are hard rules for v1:

- **No cloud / remote / multi-machine code paths.** Everything is local.
- **No Python runtime.** The entire stack — including the CLI-agent layer — is TypeScript.
- **Secrets live in the macOS Keychain only** — never in SQLite, never in a file. (The loopback session token in `daemon.json` is not a user secret and is allowed on disk.) When the daemon spawns an agent/child process it builds the child env by **stripping every `GENIRO_`-prefixed key** — daemon config and secrets travel as `GENIRO_<NAME>` (e.g. the UI passes the Cursor key as `GENIRO_CURSOR_API_KEY`) — and **re-injects only the one secret that child needs** (the Cursor adapter maps it to `CURSOR_API_KEY` for its child alone). So no spawned agent inherits another agent's credential or the daemon's internal env.
- **Every child process the daemon spawns registers with `ProcessRegistry`** (claim → register → auto-unregister on settle) so `OnApplicationShutdown` and explicit cancel terminate it — never spawn an unmanaged child. The M1 shutdown path only removes the pidfile and the UI's `SIGKILL` escalation bypasses Nest hooks, so an unregistered child orphans mid-turn (M3's graph engine spawns N agents — that is where this bites).
- **Graph definitions are YAML** (the source of truth). SQLite holds runtime/history only — never graph definitions.
- **The daemon binds loopback (`127.0.0.1`) only** and gates every non-public route with the per-launch bearer token.
- **No tmux / PTY-scraping for graph execution** in v1 (a click-through PTY mirror for inspection is a later, separate concern).
- **Never use `--no-verify`** when committing.

---

## A note on vendored packages

`packages/{common,http-server,metrics,mikroorm}` are copied from the sibling Geniro repo (`/Users/sergeirazumovskij/Desktop/Projects/Geniro/geniro`) and adapted: Sentry stripped from `common` and the `http-server` exception path; the mikroorm driver swapped Postgres → `@mikro-orm/sqlite`; OIDC auth in `http-server` left dormant. `http-server`'s `runHttpApp` / `buildHttpServerExtension` also gained backward-compatible `host` / `portFallback` / `onListening` options (so the loopback daemon can bind 127.0.0.1, fall back to a free port, and learn the bound port) — the defaults preserve Geniro's `0.0.0.0` listen behavior, so it stays upstreamable. Keep changes minimal and local-first; the goal is to stay close enough to Geniro that fixes can flow between the repos.
