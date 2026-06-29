# geniro

Local-first macOS desktop app for composing and running a **DAG of CLI coding
agents** as a team. A from-scratch rewrite of Geniro that marries Geniro's
graph engine with a local-first, CLI-agent execution layer — everything runs on
your machine, no cloud.

> **Milestone 1 — Shell + infrastructure.** This is the foundation: an Electron
> shell that supervises a bundled local daemon over loopback, with a SQLite
> store and a first-run onboarding flow. Agents, the graph, chat, the terminal
> mirror, and packaging arrive in M2–M4.

## Architecture

A pnpm + turbo monorepo whose configuration and server packages are **cloned
from the Geniro monorepo** and adapted for local-first use (SQLite instead of
Postgres, no cloud telemetry, loopback-only).

```
apps/
  shell/            @geniro/shell    — Electron main + preload + React renderer (electron-vite)
packages/
  daemon/           @packages/daemon — NestJS loopback daemon (apps/api-style) over @packages/http-server + mikro-orm SQLite
  common/           @packages/common — app bootstrapper, pino logger, exceptions (vendored from Geniro; Sentry removed)
  http-server/      @packages/http-server — NestJS + Fastify host: health, swagger/scalar, helmet, validation (vendored; OIDC auth dormant)
  metrics/          @packages/metrics — Prometheus metrics (vendored from Geniro)
  mikroorm/         @packages/mikroorm — base entity/DAO + MikroORM module (vendored; driver swapped to @mikro-orm/sqlite)
  types/            @packages/types  — shared daemon ⇄ shell wire/IPC contracts (geniro-app-specific)
```

**The daemon is a separable engine.** The Electron shell spawns the built daemon
as a child process (`ELECTRON_RUN_AS_NODE`) over loopback, waits for its
`/health/check`, then loads the renderer. The daemon writes a pidfile
(`daemon.json`: pid + port + per-launch bearer token) only after it is healthy;
a relaunching shell reuses a still-running daemon and sweeps orphaned pidfiles.

**Local-first adaptations vs Geniro** (the sibling cloud app): SQLite via
`@mikro-orm/sqlite` (better-sqlite3) instead of Postgres; no Sentry; no Redis /
cloud / OIDC; the server binds `127.0.0.1` only and is gated by a per-launch
loopback token.

**Storage split:** graph definitions → YAML (M3); settings → `settings.json` in
userData; secrets → macOS Keychain (`@napi-rs/keyring`) only; SQLite holds
runtime/history only (`runs` / `items` / `node_state`).

## Develop

```bash
pnpm install          # install workspace deps
pnpm rebuild:native   # rebuild better-sqlite3 against Electron's ABI (required)
pnpm build            # build all packages (turbo)
pnpm dev              # launch the Electron app (electron-vite) — spawns the daemon

pnpm full-check       # build + check-types + lint + unit tests
```

`pnpm rebuild:native` is required because the daemon runs under Electron's
bundled Node, so its native `better-sqlite3` must be built for Electron's ABI
(not the host Node ABI).

### Daemon endpoints (loopback)

| Route | Purpose | Auth |
|---|---|---|
| `GET /health/check` | readiness probe | public |
| `GET /metrics` | Prometheus metrics | public |
| `GET /swagger-api` · `/swagger-api/reference` | OpenAPI spec + Scalar UI | public |
| `GET /ws?token=…` | renderer ⇄ daemon WebSocket | per-launch token |
| (future M2+ routes) | runs / items / agents | bearer token (loopback guard) |

## Requirements

macOS · Node ≥ 22.12 · pnpm 11 · Xcode Command Line Tools (for the native
`better-sqlite3` build). Agent CLIs (`claude`, `cursor-agent`) are detected
during onboarding; they're driven headlessly in M2.
