# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Contents**: [Project Overview](#project-overview) · [CodeGraph](#codegraph--prefer-it-over-grepfind) · [Commands](#commands) · [Architecture](#architecture) · [Coding conventions](#coding-conventions) · [Testing conventions](#testing-conventions) · [Constraints (local-first & security)](#constraints-local-first--security) · [A note on vendored packages](#a-note-on-vendored-packages)

---

## Project Overview

**geniro-app** is a **local-first macOS desktop app** for composing and running a **DAG of CLI coding agents** as a team. It is a from-scratch rewrite of Geniro that marries Geniro's graph engine with a local-first, CLI-agent execution layer — **everything runs on the user's machine, no cloud**.

The app is an **Electron UI** that also supervises a **bundled local daemon** over loopback. The daemon is an `apps/api`-style **NestJS** app built on packages **vendored from the Geniro monorepo** and adapted for local-first use (SQLite instead of Postgres, no Sentry/Redis/cloud, loopback-only).

**Tech stack**: TypeScript 6.x, Node.js 24+, NestJS 11 (Fastify), MikroORM (`@mikro-orm/sqlite` / better-sqlite3), React 19 + Tailwind CSS v4 (electron-vite renderer), pnpm 11 + Turbo 2.10 monorepo, swc (daemon + packages) / electron-vite (UI), Vitest 4, ESLint 10 + Prettier 3.

**Status**: **All four v1 milestones are built** — M1 (UI + infrastructure), M2 (single-agent chat via CLI adapters), M3 (workflow graphs + DAG fan-out execution), M4 (CLI handoff, Settings, app self-update, macOS packaging). The plan and milestones live in `.geniro/planning/geniro-app-v1/` (`spec.md` + `milestone-1..4.md`) — this is the authoritative source for scope and sequencing. (`.geniro/planning/` is local working state, gitignored — not committed.)

**Agents (M2+)** are driven **headlessly via their CLIs only** — `claude -p`, and `cursor-agent` over its first-party **ACP** server (`cursor-agent acp`). No SDKs, no LangGraph host-side, no Python.

---

## CodeGraph — prefer it over grep/find

This repo is indexed by **CodeGraph** (a `.codegraph/` directory exists at the repo root — it is gitignored and **not committed**, but it is always present locally and must be kept in use). When you need to understand or locate code, reach for CodeGraph **before** grep/find or opening files:

- **MCP tool** (preferred): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim, line-numbered source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current source. If the tool is listed but **deferred**, load it by name via tool search rather than treating it as unavailable.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output, and takes `-p <path>` to aim it at another checkout.

Fall back to grep/Glob/Read only when CodeGraph has no answer (e.g. non-code files, or code still missing after the sync below).

**What it is structurally unable to answer, at any freshness** — don't spend a call on these: git provenance ("was this already on `main`?" → `git show origin/main:<file>`), repo-wide prevalence counts (`grep -c`), and config files, which are not symbol graphs. The mirror of that is where it beats grep outright and grep is the weaker substitute: **"does anything consume this?"** — blast radius follows dynamic dispatch, which grep cannot.

**`codegraph sync` first in any worktree — "not yet indexed" is a 15-second fix, not a reason to reach for grep.** Only the checkout holding `.codegraph/daemon.sock` is kept warm; a worktree has no daemon, so its index freezes at creation and drifts for days. `codegraph status` does **not** reliably tell you: measured 2026-08-13 (v1.1.1) on a sibling monorepo, it printed `✓ Index is up to date` on two worktrees where `sync` then found 1,087 and 629 unindexed files. A stale index answers a real symbol with `No results found` — indistinguishable from "doesn't exist" — and `codegraph_explore` fills the hole with token-level matches on unrelated code under a banner promising current on-disk source.

```bash
codegraph sync                   # from inside the worktree — resolves from the process cwd
codegraph sync <worktree-path>   # from anywhere else
# 12–23s incremental; the only authoritative staleness check
```

One sync per worktree per session is enough **until you edit files** — nothing re-syncs automatically, so a file written after it stays invisible (and a deleted file's symbols linger) until the next sync. Do not use `init`/`index` for freshness: those are full rebuilds costing ~580 MB per checkout, and this repo keeps a dozen worktrees under `.claude/worktrees/`. Nothing will ever sync one for you either: verified that after both `init` and `sync` inside a worktree, `codegraph daemons` still listed only the project roots.

**And in a worktree, pass `projectPath` on every MCP call — the tool does not follow you there** (measured 2026-08-30, v1.1.1). Syncing the worktree's index is only half the fix, because `codegraph_explore` may never look at it: its `projectPath` argument is **optional**, and omitted it uses this session's default project — the directory the session was **launched** in. `EnterWorktree` moves the shell's cwd and nothing else, so from inside a worktree the tool goes on answering from the **main checkout**, that checkout's uncommitted working tree included. Measured: from a session inside `.claude/worktrees/app-themes`, a bare call returned a `Settings.tsx` carrying a feature that existed only in uncommitted work on `main`; the same call with `projectPath` set to the worktree returned the worktree's own file. The `.codegraph/` walk-up described above is the SHELL's behaviour — the MCP tool never consults cwd at all. This is the worst shape a wrong answer can take, because nothing in the reply names which checkout it came from: it is confident, verbatim, current source from the wrong tree.

```
codegraph_explore({ projectPath: "<absolute worktree root>", … })
```

Outside a worktree the default is already right and the argument is optional. The shell form needs none of this — it resolves from the process cwd, and takes `-p <path>`. **The two halves are one trap and neither suffices alone**: a synced worktree index the MCP tool never consults is as useless as a fresh call against an index nobody synced.

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
pnpm storybook          # the component catalog (dev only; never packaged) — also View → Component Catalog in the app
```

`pnpm rebuild:native` is required because the daemon runs under Electron's bundled Node (`ELECTRON_RUN_AS_NODE`), so its native `better-sqlite3` must be built for Electron's ABI, not the host Node ABI. Run it plainly: right after every `pnpm install`, and again whenever the native ABI changes underneath you — an Electron version bump, a Node version bump, or a fresh machine/clone. Skipping it is also what breaks `@geniro/daemon` and `@packages/mikroorm`'s own unit tests — see *Testing conventions*.

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
pnpm test:cov                        # test:unit with coverage; also filterable per-workspace
```

### Seeding a throwaway profile
```bash
GENIRO_USER_DATA="$HOME/Library/Application Support/Geniro-dev" \
  pnpm --filter @geniro/daemon seed
```

Fills a database with conversations that put the chat surface's harder states on screen — several pull requests open at once, detached commands still running, a title long enough to fight the header for room — none of which is reachable without an agent spending minutes producing it. `db/seeders/` holds them (`DatabaseSeeder` composes, `UiFixturesSeeder` supplies), mirroring the sibling repo's wiring; the sibling's own seeder is an empty stub, so the naming convention is all there was to copy.

Three rules, and the first two come from `price-crawler-platform`'s seeding template, which states them best. **Seeds are IDEMPOTENT and SCOPED**: every fixture run carries a `seed-fixture-` id and each run deletes exactly those before writing, so re-seeding replaces rather than accumulates and a real conversation in the same database is untouched — never `deleteAll`. (`em.clear()` after that delete is load-bearing: the identity map still holds what was deleted, so the flush would otherwise UPDATE rows that no longer exist, and the second seed of a database silently produced no runs at all.) **Runtime-owned tables are not a seed's to touch** — `usage_events` is an append-only spend ledger, `node_state` is the executor's. And **it refuses a real profile by name** (`~/Library/Application Support/Geniro`, `~/.geniro`), because seeding writes conversations nobody asked for and there is no undo; `GENIRO_SEED_FORCE=1` is the deliberate override.

It is a DEVELOPMENT tool and never ships: `db/seed.ts` and `db/seeders/` are excluded from the swc build and from `tsconfig.build.json`, and `SeedManager` is registered in that entry point rather than in `mikro-orm.config.ts` — the config is what `main.ts` imports, `@mikro-orm/seeder` is a devDependency, and `pnpm deploy --prod` strips it, so a packaged daemon would fail to resolve it before Nest ever started. It runs under `ELECTRON_RUN_AS_NODE` like `dev` and `test:unit` rather than through `mikro-orm seeder:run`, because `better-sqlite3` is built for Electron's ABI and the CLI's host-Node process cannot open the database at all.

### Before finishing any work
```bash
pnpm full-check         # must pass before finishing
```

`full-check` chains build → check-types → build:tests → lint:fix → test:unit → test:integration. `build:tests` and `test:integration` are **no-op placeholders today** — declared in `turbo.json` (so turbo 2.10 doesn't error on them) but no package implements them yet and no `*.int.ts` exist — so it effectively gates build + types + lint + unit tests until integration tests land. `test:e2e` / `test:e2e:local` are the same kind of placeholder — root passthroughs no workspace currently implements.

CI is `.github/workflows/ci.yaml`: install → `build:packages` → `build` → `check-types` → `build:tests` → `lint` — **not** `lint:fix`, so any lint fixes made locally must be committed, never left for CI to apply — then, in its own unit-tests job, `rebuild:native` → `test:unit`, with a `ci-pass` job gating on all of it. `pnpm full-check` is the close local mirror of that sequence, but it runs `lint:fix` where CI runs `lint` — a local `full-check` pass can still fail CI if it silently fixed something you didn't commit.

### Packaging (macOS)
```bash
node scripts/make-signing-identity.mjs   # once, ever: the release signing certificate
pnpm --filter @geniro/ui build:mac       # scripts/build-mac.mjs → DMG + zip into release/dist/
```

`build:mac` signs with the certificate named by **`GENIRO_SIGN_IDENTITY`** and
is ad-hoc without it. That is not cosmetic: macOS records every privacy grant
against the app's designated requirement, and an ad-hoc signature's requirement
is the hash of its own bytes — so an ad-hoc release presents itself as a
brand-new app and re-asks for every permission the user has granted. The
release workflow sets it and FAILS if the certificate is missing rather than
shipping an unsigned artifact. See *macOS packaging* in `apps/ui/CLAUDE.md`.

### Regenerating the renderer's daemon client
```bash
pnpm generate:api       # daemon OpenAPI → apps/ui/src/renderer/autogenerated/ (committed)
```
Run after changing any daemon route or wire schema. Needs the daemon BUILT
(`pnpm build`) — it always boots a throwaway daemon on a temp userData dir,
NEVER reading one that happens to be running (which would describe an older
build and silently regenerate a client missing the route you just added).
Requires a JVM (openapi-generator-cli), same as the sibling repo.

### Dependency upgrades & commits
```bash
pnpm upgrade            # bump every workspace dep to latest (ncu, peer-aware via .ncurc) + reinstall
pnpm commit             # conventional commit via commitizen
```
Commit messages must be **conventional** (`type(scope): subject`) — the `commit-msg` husky hook runs commitlint and rejects anything else, so a plain `git commit -m "..."` message that doesn't fit the format fails at commit time. `pnpm commit` (commitizen) is the easy way to get the format right.

Two husky hooks gate a commit. `commit-msg` is the one above; **`pre-commit`** refuses any staged `.ts`/`.tsx` whose blob git would classify as **binary** — a NUL in its first 8000 bytes. Such a file has no diff, no inline review comments and no three-way merge, and nothing else can catch it, because the raw byte and its `\u0000` escape are the identical code unit at runtime: tests and types pass either way. If it fires, find the control byte and write it as the escape. It reads the INDEX, so a partially staged file is judged by the version being committed.

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
  http-server/      @packages/http-server — NestJS + Fastify host: health, swagger/scalar, helmet, validation, jose (vendored; OIDC auth dormant; + loopback listen opts host/portFallback/onListening; + utils/openapi-schemas — canonicalizes the per-direction duplicate components nestjs-zod emits, and fails the boot on a dangling $ref)
  metrics/          @packages/metrics — Prometheus metrics (vendored from Geniro)
  mikroorm/         @packages/mikroorm — TimestampsEntity base, BaseDao, MikroOrmModule (vendored; driver swapped to @mikro-orm/sqlite)
```

### The daemon (`apps/daemon`)

See **`apps/daemon/CLAUDE.md`** for the full walkthrough — module layout (`auth/`, `environments/`, `utils/`, `v1/runs/`, `v1/auth/`, `v1/agents/` incl. every adapter, `v1/graphs/`, `v1/notifications/`, `v1/diagnostics/`, `v1/handoff/`), the M2 agent-execution substrate, the M3 workflow/call runtime, and the complete `### Daemon endpoints (loopback)` table. That file is loaded automatically when `apps/daemon` is touched.

Three facts are cross-cutting enough to restate here:

- Binds **`127.0.0.1` only**. Assembled exactly like Geniro's `apps/api` (`buildBootstrapper(…)` → `addExtension(buildHttpServerExtension(…))` → `init()`); the loopback specifics ride on the extension's `host` / `portFallback` / `onListening` options — bind 127.0.0.1, negotiate a free port if the preferred one is taken, and write the pidfile from `onListening` after a healthy listen (the `http-server`'s own listen still defaults to `0.0.0.0`, preserving Geniro's behavior). Shutdown is Nest-owned (`enableShutdownHooks`); `utils/pidfile.lifecycle.ts` clears the pidfile on the way out, so `main.ts` needs no signal handling.
- Writes the pidfile (`daemon.json`: `pid`, `host`, `port`, per-launch `token`, `version`, `entry` and `startedAt`) **only after** the schema is synced and the server is listening, then prints `GENIRO_DAEMON_READY {port}` to stdout. The UI never assumes the host/port — it reads the bound values back from the pidfile (so it no longer passes `GENIRO_PORT`; the daemon owns that default).
- Config env (set by the UI): `GENIRO_USER_DATA` (userData dir; fallback `~/.geniro`), `GENIRO_PORT` (preferred port; default `47615` per `DAEMON_PREFERRED_PORT` in `utils/handshake.ts`, falling back to a free port if taken) and `GENIRO_IDLE_EXIT_MS` (self-shutdown window; absent = never, which is the default for every launch the supervisor did not spawn). DB is `geniro.db`, pidfile `daemon.json`, instance lock `daemon.lock`, child journal `children.json`, all in the userData dir.

The public allowlist is **`/health` alone** (`PUBLIC_PREFIXES` in `auth/token.guard.ts`), matched at segment boundaries so a sibling route like `/health-debug` doesn't inherit it. `/metrics` and `/swagger-api` are **token-gated**: with a deterministic default port, any web page could otherwise read the daemon's Prometheus internals and full API schema cross-origin. Every non-allowlisted route requires the `Bearer <token>` header — the launch token, or, **only** on `/v1/mcp/<runId>/<nodeId>`, that node's own per-node call token (minted when the node first needs the endpoint — for a chat that is its first turn, since every chat is now handed the endpoint for the render tools (`report_findings`, `show_chart`, `show_metrics`, `show_comparison`, `propose_patch`, `propose_plan`) — revoked at run teardown, keyed by `(runId, nodeId)` so one callee child can't open another node's route). The WS channel is a NestJS Socket.IO gateway (`@WebSocketGateway({ path: '/ws' })`) installed via the `IoAdapter` in `main.ts`; the renderer (`socket.io-client`) sends the per-launch token in the Socket.IO handshake `auth` payload (browsers can't set headers on a WS handshake). The HTTP `LoopbackTokenGuard` doesn't see Socket.IO traffic (engine.io intercepts `/ws` before Nest routing), so each gateway owns its own WS auth — via the one shared `auth/ws-auth.ts` → `enforceWsHandshakeAuth` (constant-time `safeEqual`, disconnects on mismatch), called from `handleConnection` in the notifications gateway. It stays extracted precisely so a second gateway cannot reintroduce a divergent copy of the check.

### The UI (`apps/ui`)

See **`apps/ui/CLAUDE.md`** for the full walkthrough — main process, renderer shell, chats, graphs, settings, macOS packaging, system notifications, sidebar groups, and the `DaemonSupervisor` entry-stamp logic. That file is loaded automatically when `apps/ui` is touched.


### Agent instructions — the host preamble and the user's own

**Every turn carries an instruction block, composed at ONE seam.** `AgentAdapter.composeSystemPrompt` (`adapters/agent-adapter.ts`) joins five parts, general → specific: geniro's own **host preamble**, the user's **custom instructions**, the **instruction blocks** wired to this graph node (`instructionBlocks` — a workflow's `instruction` nodes, joined by the executor in node-list order), the turn's own role (a graph node's `role`), then the caller's "May call" block. A block sits below the user's standing preference and above the node's role because one block is written once for several agents while a role belongs to the one node. The text and the ordering live in `v1/agents/utils/agent-instructions.ts` (`GENIRO_UI_PREAMBLE` + `composeTurnInstructions`); adapters never join these fields themselves, which is what `.claude/rules/agent-adapters.md` already required for the last two. Both shipped transports carry the SAME composed block — claude on `--append-system-prompt`, ACP inside the prompt text — AFTER the user's own words and wrapped in a `<host-context>` element that says what it is — since `session/new` and `session/prompt` have no system-instruction field, so a fact about the host reaches every CLI with no per-CLI branch. Neither of those ACP details is cosmetic. The prompt text is what a CLI NAMES the conversation from, so leading with the block had cursor-agent naming every chat after geniro's preamble (`Markdown Not Terminal` over a question about bloom filters); and the block arrives inside the USER's turn, so an agent ANSWERS it — `Hello!` came back as a paragraph about rich markdown transcripts, and the chat was then genuinely about geniro's preamble. See `AcpTurnDriver.composePrompt` and `HOST_CONTEXT_TAG`.

**The preamble exists to CONTRADICT the CLI's own system prompt, not merely to inform.** Claude Code ships the line `- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.` (read out of the installed 2.1.235 binary's own string table), and the only channel geniro has is additive — so the terminal claim cannot be deleted, only argued with by name. Every claim in the preamble is checked against this app's renderer rather than a vendor doc: GFM renders (`markdown-content.tsx`), a markdown image with a LOCAL path renders (`markdown-image.tsx` → `GET /v1/chats/:runId/image?path=`), and a REMOTE image does NOT — the renderer CSP is `img-src 'self' data:`, so promising one would produce a visibly broken transcript. It also never claims the model can emit an image CONTENT BLOCK (the Messages API allows `image` request-side only), and says nothing about response length, which is a separate instruction and a product choice nobody has made.

**The user's half is one global blob, snapshotted per run.** It lives in `settings.json` (`Settings.customInstructions`), rides chat create and workflow-run start on the wire under one exported `CustomInstructionsSchema` (bounded, and refusing C0 control characters — a NUL reaches `spawn` as argv, where node throws SYNCHRONOUSLY, and the snapshot would repeat that throw on every turn of that chat forever), and is stored on `Run.customInstructions`. Snapshot rather than a live read, and the difference is visible: editing the box changes the NEXT chat. That is deliberate — `AgentAdapter.sessionKey` hashes the value, so a live read would invalidate the kept CLI process mid-conversation and respawn it, taking the user's MCP servers down between two messages. A graph node's `role` outranks it (specific beats general), so the two are PEER fields rather than one joined string. The snapshot's escape hatch is `POST /v1/chats/forget-custom-instructions` behind an explicit Settings button — clearing the box changes only the next run, so without it text a user retracts keeps being sent by every chat opened beforehand; it is a press rather than a side effect of the edit precisely because it discards that per-run guarantee.

**On ACP the preamble is sent once per SESSION, not once per turn.** Prompt text is part of the conversation there — one turn is one process and the next `session/load`s the stored session — so every block a turn prepends is replayed to every turn after it. Re-sending the ~1.1KB preamble each time put roughly 40 copies (~11k tokens) inside a 40-message thread's own window, so `AcpTurnDriver` asks for it to be dropped once the session has replayed it (`composeSystemPrompt(granted, includePreamble)`). Only the preamble: the call-surface block still rides every turn, because it is true only while those tools are registered THIS turn. Claude needs none of this — its block rides `--append-system-prompt`, outside the conversation.

Two carve-outs worth knowing. An `internalProbe` turn — geniro's own capability reads, whose output is parsed and never rendered — is withheld the preamble, since there is no surface to describe and it would be argv paid on every probe. And the preamble is served back to the Settings screen over `GET /v1/capabilities` (`hostPreamble`) rather than restated in the renderer: nothing in the app renders the text a CLI actually received, so a second copy would go on describing an older preamble indefinitely.

### The daemon API client (generated — never hand-mirrored)

The renderer does not restate the daemon's HTTP shapes. `pnpm generate:api`
reads the daemon's own OpenAPI document and emits a typed client into
**`apps/ui/src/renderer/autogenerated/`** (openapi-generator `typescript-fetch`,
mirroring the sibling Geniro web app's `generate:api`). That directory is the
single source of every daemon wire type in the UI — `RunDto`, `ItemDto`,
`Workflow`, `WorkflowNode`, `AgentKind`, `CapabilitiesDto`, … — plus one API
class per swagger tag (`ChatsApi`, `AgentsApi`, `WorkflowsApi`,
`CapabilitiesApi`). It is **committed**; builds and CI never
regenerate. It is excluded from eslint and prettier, and must never be edited by
hand — run the generator instead.

`renderer/daemon-api.ts` is the only hand-written transport left. It owns the
three things a generator cannot know: the loopback base URL (host/port are
negotiated per launch and read from the pidfile), the per-launch bearer token,
and the request timeout + uniform error shape
(`daemon <METHOD> <path> failed (<status>): <detail>`) the UI is written
against. `createDaemonApis(handle)` returns every generated API class bound to
one launch — see the `DaemonApis` interface for the current, authoritative
list rather than a count restated here, which drifts.

**Regenerating**: `pnpm generate:api` (root) → `apps/ui/scripts/generate-api.sh`.
It resolves the spec from a throwaway daemon booted out of `apps/daemon/dist`
on a temp userData dir (so it needs nothing running and touches none of the
user's data), or from `GENIRO_SWAGGER_URL` when explicitly pointed at a live
one. It deliberately does NOT read whatever daemon happens to be running: the
generated client is committed, so it must describe the daemon in the WORKING
TREE — a running app can be any older build, and asking it yields a client that
regenerates clean while missing the change. Run it after changing any daemon
route or wire schema, and commit the diff.

**The daemon side of the contract** (`v1/*` modules):
- Wire shapes are **zod schemas** in each module's types file, with the shared
  ones carrying `.meta({ id })` so they land as NAMED OpenAPI components; the
  TS types are `z.infer` of those schemas, so a schema and its type cannot
  drift.
- Responses are declared with **`@ZodResponse({ status, type: SomeDto })`**
  (nestjs-zod v5) — no `@nestjs/swagger` CLI plugin is used or wanted (swc
  cannot run it). One decorator type-checks the handler's return value against
  the schema, serializes the response through it, sets the status code, and
  publishes the schema to the document.
- Every controller carries `@ApiTags` (the generated class name),
  `@ApiBearerAuth`, and `@ApiOperation({ operationId })` (the generated method
  name — descriptive and globally unique; `setupSwagger` throws on duplicates).
- A response DTO's ROOT schema must **not** carry `.meta({ id })`: nestjs-zod
  would then register the component under the id while an array response still
  points at the DTO class name. `setupSwagger` fails the boot on the resulting
  dangling `$ref` rather than letting it degrade a client type to `any`.
- `WorkflowSchema` is deliberately **default-free** so its request and response
  renderings are identical and collapse to one `Workflow` type; YAML leniency
  lives in `WorkflowYamlSchema`, which layers the defaults back on for
  `parseWorkflowYaml` only.
- `McpController` is `@ApiExcludeController()` — a JSON-RPC channel for caller
  agents, not a REST resource the UI client should see.

### Design system (renderer) — tokens + shared components

The renderer is styled with **Tailwind CSS v4 (CSS-first `@theme`)** over a **token layer kept in lockstep with the sibling Geniro web app** — same warm cream/caramel palette, same shadcn/ui semantic-token vocabulary — so the desktop app and Geniro web look identical. Its structure is **authoritative**; every new screen builds from it rather than reinventing styles.

**A THEME is one CSS file plus one row.** `styles/themes/<id>.css` holds that theme's complete set of token VALUES, and `shared/themes.ts` holds every theme's IDENTITY — its id, its label, the light-or-dark ground it paints on, and the window background main needs before a stylesheet exists. The split is not tidiness: no one language can hold both halves, since the design system forbids a colour outside CSS while `BrowserWindow.backgroundColor` and `nativeTheme.themeSource` can only be set from TypeScript. Adding a theme is exactly those two edits; `styles/themes/theme-tokens.spec.ts` fails the build if a theme file omits a token another declares (it would silently fall through to light), and `shared/themes.spec.ts` fails it if a row and a file disagree.

**The choice is applied by MAIN, and there is no IPC channel for it.** `Settings.theme` (`'system'` | a theme id, default `'system'`) is read by `main/native-appearance.ts`, which sets `nativeTheme.themeSource`. That one write themes the OS chrome the app does not paint — the traffic lights, context menus, scrollbars, system dialogs — AND drives the renderer's own `prefers-color-scheme`, from which `renderer/theme/apply-theme.ts` resolves `<html data-theme>` before the first paint. So the page and the OS cannot disagree. A live macOS appearance change reaches the PAGE through that media query alone, but the window's own `backgroundColor` is a construction option nothing re-reads — so main also keeps a `nativeTheme.on('updated')` listener (`watchSystemAppearance`) whose only job is repainting that ground, and `applyTheme` is the one exported way to apply a theme, precisely so no caller can take the OS write without the repaint. `@custom-variant dark` is re-keyed onto `data-theme` so a `dark:` utility follows the THEME rather than the OS appearance — Tailwind's own default is `@media (prefers-color-scheme: dark)`, which answers a different question the moment a user pins Light on a dark-mode Mac.

```
apps/ui/src/renderer/
  styles/themes/<id>.css   — ONE file per theme: every token VALUE, and nothing else.
                             `light.css` also carries the bare `:root` arm, so a document
                             whose theme has not resolved yet still has a full palette.
  styles/global.css        — carries NO value of its own: the tailwind import, the theme
                             imports, `@theme inline` (pure indirection, written once for
                             every theme), base typography, and the vendor retints —
                             `.md-editor-surface` for @uiw/react-md-editor's GitHub-Primer
                             variables and `.react-flow` for @xyflow's `--xy-*` ones, both
                             unlayered + double-classed on purpose, since the vendor rules
                             they beat are themselves unlayered.
  theme/apply-theme.ts     — the ONE writer of `<html data-theme>`, plus the hooks a
                             component uses when it must name the theme (the md editor).
  components/
    ui/                    — token-driven primitives, shadcn-v4 flavour (data-slot, cva variants).
                             `select` is the app's ONE dropdown — a custom panel, never a
                             native <select>, whose OS menu ignores every token and cannot
                             render groups/icons/checkmarks/search or be asserted on.
                             See `apps/ui/src/renderer/components/ui/` for the current file list.
    ...                    — app-level shared components composed from the primitives;
                             see `apps/ui/src/renderer/components/` for the current file list.
  chats/message-bubble.tsx — the transcript-row component (cva variants per item kind).
```

**Hard rules** are mechanized in `.claude/rules/renderer-design-system.md` (tokens — never hardcode a colour; `hex`/`rgb()`/`hsl()`/`oklch()`/`oklab()` are all eslint errors, incl. inside a Tailwind arbitrary value) and `.claude/rules/renderer-components.md` (never duplicate a component; the token → primitive → app-component layering; `cn()`/`cva`; no barrels). **Two mechanisms, not one**: the colour rule is the eslint override scoped to `apps/ui/src/renderer/**` (and `apps/ui/.storybook/**`, which renders the same components against the same tokens); the reuse rule is `components/catalog-coverage.spec.ts`, a filesystem-reading spec that fails the suite when a component has no co-located story, when a story outlives the component it documents, or when either is filed outside its layer's namespace. That spec enforces DISCOVERABILITY rather than de-duplication — it cannot see that two components do the same thing, only that both are in the catalog where the next person will find them before writing a third.

**The component catalog** is Storybook (`pnpm storybook`, from the root or `apps/ui`), and it is **development-only**: the packages are devDependencies, `pnpm deploy --prod` strips them, and `electron-builder.yml` ships `out/**` alone while `build-storybook` writes to the gitignored `storybook-static/` — so nothing it produces can reach a packaged app. CI runs `pnpm build-storybook` because it is the ONLY gate that compiles the story files: `check-types` covers their types, and the unit suite never renders them, so without it a broken story reaches the catalog with everything else green. The dev server binds `127.0.0.1` explicitly — Storybook's own default is the wildcard address, which serves the whole workspace over the LAN through Vite's `/@fs/` handler, in an app whose daemon deliberately binds loopback only. It is reached from **View → Component Catalog**, a row `app-menu.ts` adds only when `ELECTRON_RENDERER_URL` is set (see *The UI* → `apps/ui/CLAUDE.md`). `.storybook/preview.tsx` drives the app's OWN theme writer (`apply-theme.ts`) rather than setting `data-theme` itself — that module keeps the resolved theme in state `useThemeAppearance()` reads, so writing the attribute directly would paint the right palette while leaving that hook stale — and installs a typed `window.geniro` stub before any other import, since `main.tsx` reads the bridge at module scope. **Every new shared component needs a story in the same commit**; the spec above is what enforces it.

### Build toolchain
- **swc** compiles the daemon and all `packages/*` to **CommonJS** (`dist/`), with decorator metadata (`legacyDecorator` + `decoratorMetadata`) — entities and Nest DI rely on it. All share one root `.swcrc` (each build script references it via `--config-file ../../.swcrc`).
- **electron-vite** builds the UI (`out/`).
- Internal `@packages/*` imports resolve to **TypeScript source** via the root tsconfig path alias (`@packages/* → packages/*/src`), so the packages ship **no `.d.ts`**. Type-checking is a separate `tsc --noEmit` (`pnpm check-types`), independent of the swc build.

### Storage split
- **Graph definitions → YAML.** See *Constraints (local-first & security)* below — never stored in SQLite.
- **Settings → `settings.json`** in the Electron userData dir. The composer's chip choices are remembered here (`lastChatTarget`, `lastApprovalMode`, `lastModels` and `lastEfforts` — the last two keyed per CLI, since the two have disjoint model and effort vocabularies — plus `configDir` + `recentConfigDirs`, the optional agent config directory beside `projectFolder`/`recentFolders`) so a new run opens on the choices the user actually works in. `fastActions` is NOT more of the same — it is the user's FAST ACTIONS, and each one is only a name and a description (`chats/fast-action-bar.tsx`, drawn as buttons under the composer and managed in Settings → Fast actions). Pressing one writes its description into the message box and does nothing else, so an action names no folder, agent or model and works under whatever the composer is already set to; it bundled all of those once, and that was reported wrong on both counts — see *Fast actions* in `apps/ui/CLAUDE.md`. `runConfigs` is the OTHER hand-managed list and a DIFFERENT feature — the user's named new-chat setups (folder, branch, agent, model, effort, approval, config directory), started from the chat sidebar's `+` and managed in Settings → Run configurations. The two are near neighbours in this file and must stay two: collapsing them into one deleted the configurations and, with them, the user's saved data — see *Run configurations* in `apps/ui/CLAUDE.md`. All three are hand-managed rather than auto-evicted: nothing adds or evicts an entry, and the order is the user's, so it is preserved on read rather than re-sorted the way `recentFolders`/`recentConfigDirs` are. `configProfiles` is the THIRD, and a third feature again — the user's named agent configurations, a config directory with a name and a colour, managed on the claude card in Settings. That is why `readSettings` salvages all three keys ENTRY-BY-ENTRY (`salvageList`, twinned with `salvageCliPaths`) and re-applies the array cap there: zod rejects an array wholesale on one bad element, and each entry is hand-written and unrecoverable. **Removing a key from this schema DESTROYS what it held** — `readSettings` keeps only keys the schema knows and `writeSettings` rewrites the whole file — so any change that drops or renames one migrates or exports the data first. `notificationsEnabled` lives here too — ONE switch for both notification kinds, not one per kind: they are the same interruption seen from two sides of a turn, and a user who does not want the app talking to them outside its window does not want half of it. Values whose vocabulary belongs to the DAEMON stay opaque strings on the Electron side (`shared/contracts.ts` holds no daemon shapes); the renderer validates them against the generated enum before they reach a run. `customInstructions` lives here too — the user's standing instructions to every agent, on every provider (see *Agent instructions* below). So does `theme` (`'system'` by default, else a theme id), and it is the one key here read by the MAIN process before a window exists: `native-appearance.ts` turns it into `nativeTheme.themeSource` and `createWindow` into the window's `backgroundColor` (see *Design system (renderer)* above). It is ENUMERATED in `settingsPatchSchema`, unlike the CLI-vocabulary values beside it — a theme is a file this repo ships, so a value outside the list names nothing that can be painted, and a settings.json written by a newer build falls back to `'system'` rather than to a blank window.
- **MCP toggles → the CLI's own config** — the ONE deliberate exception to "geniro writes only its own files". claude's toggle edits `projects[<cwd>].disabledMcpServers` in `~/.claude.json`, because that is the only mechanism that reaches servers of every scope (probe-verified on 2.1.222; the settings-file `disabledMcpjsonServers` route it replaced could only ever switch off a project `.mcp.json` server, so user- and local-scope rows rendered permanently locked). Sharing the CLI's list is also the point: a switch flipped in geniro is the switch the user sees in their terminal, and the reverse. The write is a read-modify-write under `proper-lockfile` at `~/.claude.json.lock` — the SAME lock the CLI takes — plus tmp+rename, and it REFUSES on an unparseable config rather than replacing a file that holds the user's whole CLI state. geniro's own `<userData>/mcp-settings.json` and the per-turn `--settings` file are gone with it. cursor's half of the exception writes nothing directly: geniro runs that CLI's `mcp enable|disable` in the folder and lets it own the file (`~/.cursor/projects/<key>/mcp-disabled.json`), which is the same sharing with one less thing to get right.
- **Secrets → there are none.** The app stores no credentials: both CLIs authenticate from their own login state (`claude auth login`, `cursor-agent login`), so `keychain.ts`, the save/has/delete secret IPC channels, `SecretName` and the `@napi-rs/keyring` dependency were all removed. `cursor.apiKey` was the only secret this app ever held. `main/purge-legacy-secret.ts` deletes the entry earlier versions wrote, via the macOS `security` CLI (the keyring library is gone, so the built-in is what remains) — idempotent, failure-swallowing, and carrying a written expiry so a one-release migration does not become permanent. **The rule itself stands**: any future secret goes in the Keychain only — never SQLite, never a config file. A `CURSOR_API_KEY` the USER exports in their own shell is not geniro's to store; it reaches only the cursor child (see *Constraints*).
- **SQLite (`geniro.db`) → runtime/history only** — `runs` / `items` / `node_state` rows,
  the first of which carries `archivedAt`: the chat sidebar's ARCHIVE, which is the
  reversible counterpart of the teardown below — shelving a thread destroys nothing and
  the one-way purge is reached from the archive. Its own column rather than the
  `softDelete` filter's `deletedAt`, because that filter is global and default-on, so a
  row wearing it would be invisible to every read including the one that unarchives it,
  plus `usage_events`, the append-only usage ledger the Stats page reads. That one table
  is deliberately EXEMPT from run teardown: a chat delete hard-deletes its `items`, so a
  lifetime spend total computed from the transcript silently shrinks every time someone
  tidies a conversation away. It stores no new figures — every one is already in a
  `turn_complete` payload — only a longer lifetime, with the agent/model/folder dimensions
  denormalized at write time because the rows carrying them are destroyed with the run.
- **Pasted images → files** under `<userData>/attachments/<runId>/` (`AttachmentStoreService`); only the `{id, mediaType}` row rides the message item's payload, keeping blobs out of the DB. Delivery is per CLI: claude gets real base64 image **content blocks** in its stream-json stdin (probe-verified on 2.1.220 — no `Read` tool, no permission gate; `claude-images.utils.ts`). The ACP path sends the same bytes as ACP `image` content blocks in `session/prompt` (`acp/acp-content.ts`), ahead of the text block — but ONLY to an agent that advertised `promptCapabilities.image`. One that did not gets the text alone plus a `notice` naming what was withheld: the protocol requires the check, an unadvertised image block earns an error reply that would fail the whole turn over an attachment, and dropping it silently would leave the user watching the agent answer about a screenshot it never received.
- **Persist-then-emit** for streamed-then-replayable data (chat `items` and graph-node items alike): allocate the monotonic `seq`, write the row, **then** publish on the RxJS bus / per-run Socket.IO room. SQLite is the source of truth and a reconnecting client replays via an `afterSeq` cursor, so nothing is emitted before it is durable.
- The per-launch loopback **token on disk** (in `daemon.json`) is allowed — it is a local session token, not a user secret.
- **Debug log → 0600 JSONL** under `<userData>/logs/`, rotated, newest few kept (`v1/diagnostics/utils/debug-sink.ts`). It is a file the user can open, copy and paste into a bug report, so **every entry is scrubbed of registered secrets on its way in** (`utils/redact.ts` — the launch token is registered in `main.ts` one statement after it is minted, so there is no window in which it could be written unredacted; a `CURSOR_API_KEY` inherited from the user's own shell is registered on the same line and the same rule, and the per-node MCP call token registers at its own mint site in `CallTokenRegistry.issue()`, which is where a credential minted after boot has to do it). Registration, not pattern-matching: the daemon KNOWS its own secrets because it minted them, while a "looks like a token" regex both misses real ones and mangles innocent hex. With `agent-stdio` on the file also holds the raw CLI conversation — the user's own source — which is why that channel is off unless switched on.

**Two inspectors, one per process.** The renderer is a browser, so Chrome DevTools works on it unchanged — ⌥⌘I is bound on a menu item the app deliberately HIDES (`main/app-menu.ts`; the row was reported out of the menu bar, and a hidden item keeps its accelerator), and the debug panel carries a button for it (`GeniroApi.toggleDevTools` → `event.sender.toggleDevTools()`, the SENDER's own WebContents so one window cannot open another's). It covers the DOM, renderer exceptions and every daemon HTTP call and `/ws` frame the renderer makes — which is why no HTTP channel was added to the debug panel. What it can NEVER cover is the daemon or a spawned CLI: separate processes, no page, no renderer network stack. For those the daemon is spawned with `--inspect=127.0.0.1:<DAEMON_INSPECT_PORT>` when the `daemonInspect` setting is on (`DaemonSupervisor.spawnDaemon`, argv AHEAD of the entry script — placed after, node hands it to the daemon as its own argument and it silently does nothing), and `chrome://inspect` attaches real DevTools to it: breakpoints, profiler, heap. Verified under `ELECTRON_RUN_AS_NODE=1 electron`, which the daemon runs as. The port is 9229 because that is the one address `chrome://inspect` discovers with no configuration. It is a SETTING, off by default and restarting the daemon when flipped (an inspector is a launch flag): an open inspector port is code execution inside the daemon for anything that reaches loopback — fine on a single-user machine, not something to hand a packaged install unasked. Note the split in what each shows: the daemon's own log lines do NOT appear in its inspector Console (pino and Nest's `ConsoleLogger` write to fd 1 directly, bypassing the `console` object the inspector forwards) — the log is the debug panel's job, the inspector's is the code.

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
- **CLI agent adapters**: every fact about a specific CLI lives in that CLI's own adapter layer (a field of its `AdapterConfig` or an abstract method on `AgentAdapter`) — never in a branch elsewhere in the daemon — and ACP is the preferred transport for any new agent; mechanized in full in `.claude/rules/agent-adapters.md`.
- **"Workflow" is the thing, "graph" is its shape.** A workflow is what the user makes, names, opens and runs — every user-visible string says so, and so does the entity in code (`Workflow`, `WorkflowsApi`, `WorkflowStoreService`). `graph` is reserved for the DAG inside one: the executor, the topological order, the validator, the edges, the canvas. So the renderer's screen is `workflows/Workflows.tsx` while the daemon's engine module stays `v1/graphs/`. See *Workflows* in `apps/ui/CLAUDE.md` for what the split cost when it was not observed.
- **Renderer UI follows the design system** (see *Design system (renderer)* above): colours come from tokens only, and reusable UI is always a shared component, never re-implemented inline; mechanized in full in `.claude/rules/renderer-design-system.md` + `.claude/rules/renderer-components.md`.

---

## Testing conventions

- **Vitest**, transformed by **swc** (`vitest.base.ts` — `unplugin-swc` + `tsconfigPaths`). Tests run from source; no build step needed.
- **`@geniro/daemon` and `@packages/mikroorm` run their vitest suite under Electron**, so `pnpm rebuild:native` must have already run against Electron's ABI — on a host-ABI tree, `base.dao.spec.ts` fails and segfaults the runner (exit 139) instead of reporting an ordinary test failure. This is why CI runs `rebuild:native` inside its own unit-tests job rather than assuming an earlier step already did.
- **Unit tests** are co-located as `*.spec.{ts,tsx}` next to the source. Run with `pnpm test:unit`, or target one workspace with `pnpm --filter <name> test:unit`. **Never** call `vitest` directly.
- **Specs are TYPE-CHECKED.** `pnpm check-types` runs `tsc --noEmit -p tsconfig.json` in every workspace, and that project includes `src/**` — specs and `__tests__/` helpers with it. (`tsconfig.build.json`, which excludes both, is for the swc build's file list only; it is never the type gate.) Vitest transpiles through swc and checks nothing, so a spec left out of the gate can assert against a shape the daemon no longer has and stay green indefinitely — which is exactly what had happened: 113 daemon errors accumulated silently, including fixtures missing fields that had been required for releases. Never narrow a workspace's `check-types` back to a spec-excluding project.
- **React component tests** (UI renderer) must put `// @vitest-environment jsdom` on line 1 — the default project environment is `node`. When a `vi.mock(...)` factory closes over module-scope spies, wrap them in `vi.hoisted(() => ({ … }))`.
- **Must-fail policy**: tests never conditionally skip on missing env/services — a missing prerequisite must fail loudly, not `it.skip`.
- **No flaky tests**: nondeterminism is a bug to fix at the source, not retry around. When any pre-existing problem (failing test, broken local step, latent bug) surfaces mid-task, surface it and propose a fix — never silently skip it.
- **No false pins** (mechanized in `.claude/rules/testing.md`): a test whose name or comment claims to pin a behavior must FAIL when that behavior is reverted; assert the real observable, never a proxy the test itself fabricated; and a defensive branch worth writing is worth a test that enters it.

---

## Constraints (local-first & security)

These are hard rules for v1:

- **No cloud SERVICE of geniro's own, and no remote or multi-machine code paths.** Everything geniro runs, stores and computes is on the user's machine: there is no geniro backend, no telemetry, no account, and nothing syncs between machines. Two shapes of outbound call are allowed, and they are genuinely different — one predicate covering both would either condemn a shipped feature or widen into permitting any HTTP GET at all:

  1. **The user's own credential, the user's own data.** `main/github-prs.ts` runs the user's `gh` CLI against their own repositories. geniro holds no token — it borrows a login the user already made, and degrades to silence when that login or the network is absent.
  2. **An anonymous read of geniro's OWN public release metadata and artifacts**, from one fixed host: `main/updater.ts` (the releases feed) and `main/update-installer.ts` (the checksums and the archive). No credential, no user data, nothing the user chose.

  What stays refused is the thing the rule is actually for: geniro holding a credential of its own, running a server, syncing the user's data anywhere, or talking to a machine on someone else's say-so.
- **No Python runtime.** The entire stack — including the CLI-agent layer — is TypeScript.
- **Secrets live in the macOS Keychain only** — never in SQLite, never in a file. (The loopback session token in `daemon.json` is not a user secret and is allowed on disk.) The app currently stores **no secrets at all** — both CLIs carry their own login — so this is policy awaiting its next case, not a description of live code. When the daemon spawns an agent/child process it builds the child env by **stripping every `GENIRO_`-prefixed key** — daemon config travels as `GENIRO_<NAME>` (e.g. `GENIRO_USER_DATA`, `GENIRO_CLAUDE_BIN`) — **plus a named set of credentials it must not hand across agents** (`CURSOR_API_KEY`, the Anthropic keys, `CLAUDE_CONFIG_DIR`; see `utils/child-env.ts`), and **re-injects only what a given child is entitled to**: the Anthropic credentials for the definitionally-claude paths, and a `CURSOR_API_KEY` the user exported in their own shell for the cursor child alone. So no spawned agent inherits another agent's credential or the daemon's internal env. Note the strip is what makes this true, not the absence of a key: the credentials on that list are ones the daemon INHERITED rather than minted, so leaving any of them unstripped would hand the user's own credential to the wrong agent.
- **Every child process the daemon spawns registers with `ProcessRegistry`** (claim → register → auto-unregister on settle) so `OnApplicationShutdown` and explicit cancel terminate it — never spawn an unmanaged child. The M1 shutdown path only removes the pidfile and the UI's `SIGKILL` escalation bypasses Nest hooks, so an unregistered child orphans mid-turn (M3's graph engine spawns N agents — that is where this bites).
- **Every DETACHED child group is also written to the child journal** (`v1/agents/utils/child-journal.ts` → `<userData>/children.json`), and the next boot reaps whatever survived (`services/stranded-child-reaper.service.ts`, called first in `main.ts` before the schema sync so no turn can race it). `ProcessRegistry` is in memory, so it can only serve the GRACEFUL path; a SIGKILL skips Nest's hooks entirely and a `detached` group is not in the daemon's own process group, so it is reparented to launchd and runs until reboot. The journal is the only mechanism that survives that. Recording happens inside the spawn helpers themselves (`defaultSpawn` in `utils/spawn-cli.ts`, and `AgentAdapter.runAsProcessGroup`, whose `mcp list` launches the user's own MCP servers) — the pid exists there and nowhere earlier, and a record written later leaves a window where a group is running and unrecorded. The reaper **never kills on a pid alone**: each entry is re-confirmed through `utils/process-identity` first, because a pid recorded hours ago may by then be the user's own interactive `claude`. Unconfirmable entries are left alone — a surviving stray costs memory, a mistaken SIGKILL costs the user's work. A plain `execFile` utility child is deliberately NOT journaled (single pid, node's own timeout, exits in under a second).
- **Graph definitions are YAML** (the source of truth). SQLite holds runtime/history only — never graph definitions.
- **The daemon binds loopback (`127.0.0.1`) only** and gates every non-public route with the per-launch bearer token.
- **No tmux / PTY-scraping for graph execution** in v1. A click-through PTY mirror for inspection WAS built and then removed (M4) — see `v1/handoff/` in `apps/daemon/CLAUDE.md` — because it could not follow a running turn; inspection today is handing the conversation off to the user's own terminal, never a scraped mirror.
- **Never use `--no-verify`** when committing.

---

## A note on vendored packages

`packages/{common,http-server,metrics,mikroorm}` are copied from the sibling Geniro repo (`/Users/sergeirazumovskij/Desktop/Projects/Geniro/geniro`) and adapted: Sentry stripped from `common` and the `http-server` exception path; the mikroorm driver swapped Postgres → `@mikro-orm/sqlite`; OIDC auth in `http-server` left dormant. `http-server`'s `runHttpApp` / `buildHttpServerExtension` also gained backward-compatible `host` / `portFallback` / `onListening` options (so the loopback daemon can bind 127.0.0.1, fall back to a free port, and learn the bound port) — the defaults preserve Geniro's `0.0.0.0` listen behavior, so it stays upstreamable. `mikroorm`'s `BaseDao` gained `hardDeleteIncludingSoftDeleted` — a purge that reaches rows the `softDelete` filter hides, added for the chat DELETE route; it is a separate method rather than a flag on `hardDelete` so the destructive form can never be reached by passing an option through. Keep changes minimal and local-first; the goal is to stay close enough to Geniro that fixes can flow between the repos.
