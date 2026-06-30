# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**geniro-app** is a **local-first macOS desktop app** for composing and running a **DAG of CLI coding agents** as a team. It is a from-scratch rewrite of Geniro that marries Geniro's graph engine with a local-first, CLI-agent execution layer — **everything runs on the user's machine, no cloud**.

The app is an **Electron shell** that supervises a **bundled local daemon** over loopback. The daemon is an `apps/api`-style **NestJS** app built on packages **vendored from the Geniro monorepo** and adapted for local-first use (SQLite instead of Postgres, no Sentry/Redis/cloud, loopback-only).

**Tech stack**: TypeScript 6.x, Node.js 24+, NestJS 11 (Fastify), MikroORM (`@mikro-orm/sqlite` / better-sqlite3), React 19 (electron-vite renderer), pnpm + Turbo monorepo, swc (daemon + packages) / electron-vite (shell).

**Status**: **Milestone 1 (shell + infrastructure) is built.** Agents, the graph engine, chat, the terminal mirror, and packaging arrive in M2–M4. The plan and milestones live in `.geniro/planning/geniro-app-v1/` (`spec.md` + `milestone-1..4.md`) — this is the authoritative source for scope and sequencing.

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
pnpm build              # build everything (turbo → swc for packages+daemon, electron-vite for shell)
pnpm dev                # launch the Electron app (electron-vite) — spawns + supervises the daemon
pnpm daemon:dev         # run the daemon alone (tsx watch) — useful for daemon-only iteration
```

`pnpm rebuild:native` is required because the daemon runs under Electron's bundled Node (`ELECTRON_RUN_AS_NODE`), so its native `better-sqlite3` must be built for Electron's ABI, not the host Node ABI.

### Build, types, lint
```bash
pnpm build              # turbo run build (swc → dist/ for packages & daemon; electron-vite → out/ for shell)
pnpm check-types        # turbo run check-types (tsc --noEmit per package — swc does NOT type-check)
pnpm lint               # eslint, no fixes
pnpm lint:fix           # eslint + prettier auto-fix
```

### Testing
Always use the package.json scripts — never call `vitest` directly.
```bash
pnpm test:unit                       # all unit tests (vitest, *.spec.{ts,tsx})
pnpm --filter @packages/daemon test:unit   # one package
pnpm --filter @geniro/shell test:unit      # the shell
```

### Before finishing any work
```bash
pnpm full-check         # must pass before finishing
```

`full-check` chains build → check-types → build:tests → lint:fix → test:unit → test:integration. `build:tests` and `test:integration` are **no-op placeholders today** — declared in `turbo.json` (so turbo 2.10 doesn't error on them) but no package implements them yet and no `*.int.ts` exist — so it effectively gates build + types + lint + unit tests until integration tests land.

### Dependency upgrades & commits
```bash
pnpm upgrade            # bump every workspace dep to latest (ncu, peer-aware via .ncurc) + reinstall
pnpm commit             # conventional commit via commitizen
```

> Database: the daemon **syncs the SQLite schema additively on launch** (`orm.schema.update({ safe: true })` — never destructive). There is **no Migrator / migration files yet**; the full versioned migration workflow is deferred to M2. Do not hand-write migrations.

---

## Architecture

A **pnpm + Turbo monorepo** whose root config and server packages are **cloned from the Geniro monorepo** and adapted for local-first use.

```
apps/
  shell/            @geniro/shell    — Electron main + preload + React renderer (electron-vite)
packages/
  daemon/           @packages/daemon — NestJS loopback daemon (apps/api-style) over @packages/http-server + mikro-orm SQLite
  common/           @packages/common — AppBootstrapper, pino logger, exceptions (vendored from Geniro; Sentry removed)
  http-server/      @packages/http-server — NestJS + Fastify host: health, swagger/scalar, helmet, validation, jose (vendored; OIDC auth dormant)
  metrics/          @packages/metrics — Prometheus metrics (vendored from Geniro)
  mikroorm/         @packages/mikroorm — TimestampsEntity base, BaseDao, MikroOrmModule (vendored; driver swapped to @mikro-orm/sqlite)
```

### The daemon (`packages/daemon`)
A standalone NestJS engine the shell spawns as a child process. Key files: `main.ts` (bootstrap), `app.module.ts`, `config.ts` (env → `DaemonConfig`), `handshake.ts` (pidfile `DaemonInfo` shape + loopback bind defaults + port/pid validators), `token.guard.ts` + `safe-equal.ts` (loopback bearer-token gate), `ws.ts` (token-gated WebSocket), `pidfile.ts` (mint/write/reconcile), `db/mikro-orm.config.ts`, `entities/{run,item,node-state}.entity.ts` + `entities/types.ts` (status/kind enums).

- Binds **`127.0.0.1` only** (the cloned `http-server` bootstrapper hardcodes `0.0.0.0`, so the daemon assembles via `AppBootstrapper` + `buildHttpNestApp` and calls `app.listen` itself).
- Writes the pidfile (`daemon.json`: `pid`, `host`, `port`, per-launch `token`, `version`, `startedAt`) **only after** the schema is synced and the server is listening, then prints `GENIRO_DAEMON_READY {port}` to stdout. The shell never assumes the host/port — it reads the bound values back from the pidfile (so it no longer passes `GENIRO_PORT`; the daemon owns that default).
- Config env (set by the shell): `GENIRO_USER_DATA` (userData dir; fallback `~/.geniro`) and `GENIRO_PORT` (preferred port; falls back to a free port if taken). DB is `geniro.db`, pidfile `daemon.json`, both in the userData dir.

### Daemon endpoints (loopback)
| Route | Purpose | Auth |
|---|---|---|
| `GET /health/check` | readiness probe (`{status, version}`) | public |
| `GET /metrics` | Prometheus metrics | public |
| `GET /swagger-api` · `/swagger-api/reference` | OpenAPI spec + Scalar UI | public |
| `GET /ws?token=…` | renderer ⇄ daemon WebSocket (hello + echo in M1) | per-launch token |
| (future M2+ routes) | runs / items / agents | bearer token (`LoopbackTokenGuard`) |

The public allowlist (`/health`, `/metrics`, `/swagger-api`) is matched at segment boundaries; every other route requires the `Bearer <token>` header. WS auth uses a `token` query param (browsers can't set headers on a WS handshake), compared with `safeEqual` (constant-time).

### The shell (`apps/shell`)
electron-vite project. `src/main/` — `index.ts` (app lifecycle), `daemon-supervisor.ts` (spawn/adopt/health-poll/orphan-sweep), `daemon-pidfile.ts` (reads + validates the daemon's pidfile), `settings.ts` (`settings.json`), `keychain.ts` (`@napi-rs/keyring`), `cli-detect.ts`, `ipc.ts`. `src/shared/contracts.ts` holds the IPC/Settings/CLI/Keychain contracts + `DaemonHandle`, shared across main/preload/renderer. `src/preload/index.ts` exposes a typed `window.geniro` via `contextBridge`. `src/renderer/` — React app (`App.tsx`, `onboarding/`, `daemon-client.ts` WS client).

`DaemonSupervisor.start()` reuses a still-healthy daemon left by a prior shell instance (pid + `/health/check` match), sweeps stale pidfiles, and only tears down the process it owns.

### Build toolchain
- **swc** compiles the daemon and all `packages/*` to **CommonJS** (`dist/`), with decorator metadata (`legacyDecorator` + `decoratorMetadata`) — entities and Nest DI rely on it. Each has a `.swcrc`.
- **electron-vite** builds the shell (`out/`).
- Internal `@packages/*` imports resolve to **TypeScript source** via the root tsconfig path alias (`@packages/* → packages/*/src`), so the packages ship **no `.d.ts`**. Type-checking is a separate `tsc --noEmit` (`pnpm check-types`), independent of the swc build.

### Storage split
- **Graph definitions → YAML** (M3) — the source of truth; never stored in SQLite.
- **Settings → `settings.json`** in the Electron userData dir.
- **Secrets → macOS Keychain only** (`@napi-rs/keyring`) — never SQLite, never a config file.
- **SQLite (`geniro.db`) → runtime/history only** — `runs` / `items` / `node_state` rows.
- The per-launch loopback **token on disk** (in `daemon.json`) is allowed — it is a local session token, not a user secret.

---

## Coding conventions

- **No `any`** — use specific types, generics, or `unknown` + type guards.
- **All imports at the top** of the file.
- **Naming**: PascalCase for classes/interfaces/enums/types; camelCase for variables/functions.
- **Errors**: throw the custom exceptions from `@packages/common` (e.g. `NotFoundException`, `BadRequestException`). Never swallow errors silently.
- **Shared packages** are aliased as `@packages/*` (e.g. `import { … } from '@packages/common'`), resolving to each package's `src`.
- **Entities** use `@mikro-orm/decorators/legacy` decorators, extend `TimestampsEntity` from `@packages/mikroorm`, and declare **explicit column types** (`@PrimaryKey({ type: 'string' })`, `@Property({ type: 'integer' | 'text' | … })`) — MikroORM's discovery needs them under swc.
- **New daemon feature modules** follow the layered structure as they're added: Controller (route + validation only) → Service (business logic) → DAO (extends `BaseDao`, injects `EntityManager` from `@mikro-orm/sqlite`) → Entity. Use Zod DTOs via `createZodDto()` from `nestjs-zod` for HTTP input.

---

## Testing conventions

- **Vitest**, transformed by **swc** (`vitest.base.ts` — `unplugin-swc` + `tsconfigPaths`). Tests run from source; no build step needed.
- **Unit tests** are co-located as `*.spec.{ts,tsx}` next to the source. Run with `pnpm test:unit`, or target one workspace with `pnpm --filter <name> test:unit`. **Never** call `vitest` directly.
- **React component tests** (shell renderer) must put `// @vitest-environment jsdom` on line 1 — the default project environment is `node`. When a `vi.mock(...)` factory closes over module-scope spies, wrap them in `vi.hoisted(() => ({ … }))`.
- **Must-fail policy**: tests never conditionally skip on missing env/services — a missing prerequisite must fail loudly, not `it.skip`.
- **No flaky tests**: nondeterminism is a bug to fix at the source, not retry around. When any pre-existing problem (failing test, broken local step, latent bug) surfaces mid-task, surface it and propose a fix — never silently skip it.

---

## Constraints (local-first & security)

These are hard rules for v1:

- **No cloud / remote / multi-machine code paths.** Everything is local.
- **No Python runtime.** The entire stack — including the CLI-agent layer — is TypeScript.
- **Secrets live in the macOS Keychain only** — never in SQLite, never in a file. (The loopback session token in `daemon.json` is not a user secret and is allowed on disk.)
- **Graph definitions are YAML** (the source of truth). SQLite holds runtime/history only — never graph definitions.
- **The daemon binds loopback (`127.0.0.1`) only** and gates every non-public route with the per-launch bearer token.
- **No tmux / PTY-scraping for graph execution** in v1 (a click-through PTY mirror for inspection is a later, separate concern).
- **Never use `--no-verify`** when committing.

---

## A note on vendored packages

`packages/{common,http-server,metrics,mikroorm}` are copied from the sibling Geniro repo (`/Users/sergeirazumovskij/Desktop/Projects/Geniro/geniro`) and adapted: Sentry stripped from `common` and the `http-server` exception path; the mikroorm driver swapped Postgres → `@mikro-orm/sqlite`; OIDC auth in `http-server` left dormant. Keep changes minimal and local-first; the goal is to stay close enough to Geniro that fixes can flow between the repos.
