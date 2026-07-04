# geniro

Local-first macOS desktop app for composing and running a **DAG of CLI coding
agents** as a team. A from-scratch rewrite of Geniro that marries Geniro's
graph engine with a local-first, CLI-agent execution layer — everything runs on
your machine, no cloud.

> **Milestone 1 — UI + infrastructure.** This is the foundation: an Electron
> UI that supervises a bundled local daemon over loopback, with a SQLite
> store and a first-run onboarding flow. Agents, the graph, chat, the terminal
> mirror, and packaging arrive in M2–M4.

## Install (macOS, Apple Silicon)

Builds are **ad-hoc signed** (no Apple Developer ID). Both install paths strip
the macOS quarantine flag so Gatekeeper doesn't block the app — the Homebrew
cask does it in a `postflight`, the install script via `xattr`. (A DMG opened
straight from a browser download **would** be blocked — use brew or the script.)

**Homebrew (recommended):**

```sh
brew tap geniro-io/tap
brew trust geniro-io/tap       # third-party taps need an explicit trust (Homebrew 6+)
brew install --cask geniro     # ad-hoc/unsigned; the cask strips the quarantine bit post-install
brew upgrade --cask geniro     # later, to update
```

**Install script:**

```sh
curl -fsSL https://raw.githubusercontent.com/geniro-io/geniro-app/main/scripts/install.sh -o /tmp/geniro-install.sh
bash /tmp/geniro-install.sh                    # re-run to update
```

Geniro **notifies** you when a newer release exists (Settings → Check now) but
does not silently self-update — you update via `brew upgrade` or by re-running
the script. Silent in-app auto-update requires a real Developer ID + notarization
(see *Releasing* below); the code path for it is retained but disabled.

## Releasing

Pushing to `main` runs `.github/workflows/release.yaml`: `semantic-release`
determines the version and tags `v<x.y.z>`, a GitHub Release is cut, then the
`build-app` job (macOS runner) syncs `apps/ui` to the tag, runs
`build:mac` (ad-hoc), and attaches `Geniro-<v>-arm64.dmg` + `-arm64-mac.zip`.

**To enable the Homebrew tap** (optional — the `.dmg`/`.zip` + install script
work without it): create a `geniro-io/homebrew-tap` repo (seed it with
[`packaging/homebrew/geniro.rb`](packaging/homebrew/geniro.rb)), then set the
repo **variable** `HOMEBREW_TAP_REPO=geniro-io/homebrew-tap` and the **secret**
`HOMEBREW_TAP_TOKEN` (a PAT with write access to the tap). The `bump-cask` job
then rewrites the cask's version + sha256 on each release; until both are set it
is skipped.

**To switch to a signed build with silent auto-update** (needs a paid Apple
Developer account): add the `CSC_LINK` / `CSC_KEY_PASSWORD` / `CSC_NAME` and
notarization secrets, flip `mac.notarize` to `true` and revisit the
`signIgnore: Resources/daemon/` entry in `apps/ui/electron-builder.yml`
(notarization requires every Mach-O signed). `scripts/build-mac.mjs` already
injects the GitHub update feed only when `CSC_*` is present, so signing and the
in-app updater turn on together.

## Architecture

A pnpm + turbo monorepo whose configuration and server packages are **cloned
from the Geniro monorepo** and adapted for local-first use (SQLite instead of
Postgres, no cloud telemetry, loopback-only).

```
apps/
  ui/               @geniro/ui       — Electron main + preload + React renderer (electron-vite)
  daemon/           @geniro/daemon   — NestJS loopback daemon (apps/api-style) over @packages/http-server + mikro-orm SQLite
packages/
  common/           @packages/common — app bootstrapper, pino logger, exceptions (vendored from Geniro; Sentry removed)
  http-server/      @packages/http-server — NestJS + Fastify host: health, swagger/scalar, helmet, validation (vendored; OIDC auth dormant)
  metrics/          @packages/metrics — Prometheus metrics (vendored from Geniro)
  mikroorm/         @packages/mikroorm — base entity/DAO + MikroORM module (vendored; driver swapped to @mikro-orm/sqlite)
```

**The daemon is a separable engine.** The Electron UI spawns the built daemon
as a child process (`ELECTRON_RUN_AS_NODE`) over loopback, waits for its
`/health/check`, then loads the renderer. The daemon writes a pidfile
(`daemon.json`: pid + host + port + per-launch bearer token) only after it is
healthy, and the UI discovers the bound host + port by reading it; a
relaunching UI reuses a still-running daemon and sweeps orphaned pidfiles.

**Local-first adaptations vs Geniro** (the sibling cloud app): SQLite via
`@mikro-orm/sqlite` (better-sqlite3) instead of Postgres; no Sentry; no Redis /
cloud / OIDC; the server binds `127.0.0.1` only and is gated by a per-launch
loopback token.

**Build toolchain:** the daemon and all `packages/*` compile with **swc** to
CommonJS (`dist/`); the Electron UI builds with **electron-vite**. Internal
`@packages/*` imports resolve to TypeScript source via a tsconfig path alias, so
the packages ship no `.d.ts` and type-checking runs as a separate `tsc --noEmit`
(`pnpm check-types`).

**Storage split:** graph definitions → YAML (M3); settings → `settings.json` in
userData; secrets → macOS Keychain (`@napi-rs/keyring`) only; SQLite holds
runtime/history only (`runs` / `items` / `node_state`).

## Develop

```bash
pnpm install          # install workspace deps
pnpm rebuild:native   # rebuild better-sqlite3 against Electron's ABI (required)
pnpm build            # build all packages + the UI (turbo → swc / electron-vite)
pnpm dev              # launch the Electron app (electron-vite) — spawns the daemon

pnpm full-check       # build + check-types + lint + unit tests
pnpm upgrade          # bump every workspace dep to latest (ncu, peer-aware) + reinstall
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

macOS · Node ≥ 24 · pnpm 11 (via `corepack`) · Xcode Command Line Tools (for the
native `better-sqlite3` build). Agent CLIs (`claude`, `cursor-agent`) are
detected during onboarding; they're driven headlessly in M2.

## License

[Apache License 2.0](LICENSE) — see also [`NOTICE`](NOTICE) for attribution.
