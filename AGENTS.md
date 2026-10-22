# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor) working in this repository.

- Guidance lives only in `AGENTS.md` files: this one, `apps/daemon/AGENTS.md` and `apps/ui/AGENTS.md`.
- Each of those directories also has a `CLAUDE.md` that is exactly one line, `@AGENTS.md`. Never write guidance in a `CLAUDE.md`; a guide added in a new directory gets both files.
- Why both: Codex reads only `AGENTS.md` (root down to its start directory, first 32 KiB of the chain); Cursor reads `AGENTS.md` at every level; Claude Code receives a nested guide whole only through the `CLAUDE.md` import.
- Codex truncates at 32 KiB, so keep the rules an agent must not miss near the top of this file.

**Contents**: [Repository rules](#repository-rules) · [Issues and pull requests](#issues-and-pull-requests) · [Project Overview](#project-overview) · [CodeGraph](#codegraph--prefer-it-over-grepfind) · [Commands](#commands) · [Coding conventions](#coding-conventions) · [Testing conventions](#testing-conventions) · [Constraints (local-first & security)](#constraints-local-first--security) · [Architecture](#architecture) · [A note on vendored packages](#a-note-on-vendored-packages)

---

## Repository rules

The rules under `.claude/rules/` are part of this file's contract. Claude Code loads each one by itself when a file under its `paths:` is touched. Cursor reads each one through `.cursor/rules/<name>.mdc`, a committed file generated from the rule: its `paths:` become Cursor's `globs:`, so Cursor attaches the rule by itself when a matching file is in context, and a rule without `paths:` becomes `alwaysApply: true`. Codex never reads `.claude/rules/`. So on Codex, and on Cursor when the rule is not already in context, open the matching rule and follow it before editing a file under its paths.

<!-- prettier-ignore -->
| Rule | Applies to | What it holds |
| --- | --- | --- |
| [`daemon-module-structure.md`](.claude/rules/daemon-module-structure.md) | `apps/daemon/src/**` | Feature-module directory layout: thin controllers, types files, `__tests__/`, twin parsers |
| [`database-queries.md`](.claude/rules/database-queries.md) | `apps/daemon/src/**` | Queries through MikroORM's QueryBuilder or its typed Kysely builder, never hand-written SQL; transactions use their own `EntityManager` |
| [`agent-adapters.md`](.claude/rules/agent-adapters.md) | `apps/daemon/src/v1/agents/**` | Every fact about a CLI lives in its own adapter; ACP first |
| [`mcp-tools.md`](.claude/rules/mcp-tools.md) | `apps/daemon/src/v1/mcp/**`, `apps/daemon/src/v1/agents/utils/host-*.ts` | geniro's own MCP tools: one directory per tool, shared base class and interface |
| [`renderer-components.md`](.claude/rules/renderer-components.md) | `apps/ui/src/renderer/**` | Reuse layers (token → primitive → shared component), no duplicates, the component catalog |
| [`renderer-design-system.md`](.claude/rules/renderer-design-system.md) | `apps/ui/src/renderer/**`, `apps/ui/.storybook/**` | Styling from design tokens only, never a hardcoded colour; one file per theme |
| [`renderer-overlay-primitives.md`](.claude/rules/renderer-overlay-primitives.md) | `apps/ui/src/renderer/components/ui/{menu,popover,dialog,context-menu}.tsx` | Placement internals of the menu/popover/dialog primitives |
| [`renderer-stories.md`](.claude/rules/renderer-stories.md) | `apps/ui/src/renderer/**/*.stories.tsx`, `apps/ui/.storybook/**` | How to write a component's Storybook story |
| [`packaging-config.md`](.claude/rules/packaging-config.md) | `scripts/**`, `apps/ui/electron-builder.yml` | An env-signal branch owns every config value it controls |
| [`testing.md`](.claude/rules/testing.md) | `**/*.spec.ts`, `**/*.spec.tsx` | No false pins: a claimed behaviour has an assertion that fails when it breaks |

Add a new rule file to this table in the same change, with the paths its frontmatter declares, then run `pnpm sync:cursor-rules` and commit the `.cursor/rules/<name>.mdc` it writes; never edit a generated file by hand. A rule's frontmatter holds only a one-line `description:` and an optional `paths:` block list with no brace group (Cursor splits `globs:` on commas), and the script refuses anything else. `pnpm sync:cursor-rules --check` (in CI and `full-check`) fails on a missing, stale or extra file. The table is the only way a rule reaches Codex.

---

## Issues and pull requests

Agents may file issues and open pull requests. The human version is [`CONTRIBUTING.md`](CONTRIBUTING.md).

**Filing an issue**

- Search first (`gh issue list -R geniro-io/geniro-app --state all --search "<words>"`); comment on a match instead of opening a duplicate.
- The forms in `.github/ISSUE_TEMPLATE/` are web-only. From `gh issue create` or the API, write the body with the same `###` headings the form produces, and pass `--label bug` or `--label enhancement`.
- Bug: `### Geniro version`, `### macOS version and chip`, `### Which agent was involved?` (claude / cursor-agent / codex / a workflow / none), `### Agent CLI version`, `### Steps to reproduce`, `### What happened, and what did you expect?`, `### Debug log`, `### Anything else?`. Write "unknown" rather than guessing a version.
- Feature: `### What problem are you trying to solve?`, `### What would you like to happen?`, `### What do you do today instead?`, `### Would you like to work on it?`. A request that needs a cloud service, telemetry or an account is out of scope (see _Constraints_).
- Never paste a debug log you have not read: it can hold paths and, with `agent-stdio` on, the user's conversation.

**Opening a pull request**

1. Work on a branch, never `main` (it accepts only pull requests that pass `CI Pass`). Without push access: `gh repo fork geniro-io/geniro-app --clone`, push to the fork, `gh pr create -R geniro-io/geniro-app`.
2. The PR title is the release: PRs are squash-merged and semantic-release reads the title, so use `type(scope): subject` (`fix(ui): …`, `feat(daemon): …`). Commit messages use the same format.
3. Every PR body follows `.github/pull_request_template.md`. `gh pr create --body` replaces the template, so write its headings yourself, in order: `## Why` (with `Closes #N` when there is an issue), `## What changed`, `## How it was verified`, `## Not in this PR` ("nothing" when empty), `## AI assistance` (name the agent), `## Checklist` (tick only what was actually done).
4. Before pushing, `pnpm full-check` passes and any fixes its `lint:fix` made are committed (CI runs `lint` without fixing). A changed daemon route or wire schema also needs `pnpm generate:api` with the regenerated client committed.
5. One concern per PR; open it with `--draft` while unfinished.

The issue-heading and PR-heading lists above are twins of the forms and the template: change one, change the other in the same commit.

**Never, in a contribution**

- Commit a credential, token or `.env` file.
- Hand-edit `apps/ui/src/renderer/autogenerated/` (regenerate it).
- Add a cloud service, telemetry or an account.
- Reformat or restructure code the change does not need, especially vendored `packages/*` files.
- Delete a persisted settings key without migrating what it holds (see _Storage split_).

**Where checks run**: CI is `ubuntu-22.04`, headless, so a Linux sandbox can run all of `pnpm full-check`. `pnpm generate:api` also needs a JVM. Driving the real UI on headless Linux is the `run-desktop` skill (`.claude/skills/run-desktop/`); on a Mac use `pnpm dev`.

---

## Project Overview

geniro-app is a local-first macOS desktop app for composing and running a DAG of CLI coding agents as a team. Everything runs on the user's machine; there is no cloud.

- An Electron UI (`apps/ui`) supervises a bundled NestJS daemon (`apps/daemon`) that listens on loopback only.
- The daemon is built on packages vendored from the sibling Geniro monorepo, adapted for local use (SQLite, no Sentry/Redis/cloud).
- Agents are driven headlessly through their CLIs only: `claude -p`, `cursor-agent acp` (ACP), and `codex app-server` (its own JSON-RPC). No SDKs, no LangGraph, no Python.
- Every fact about one CLI lives in its own adapter: `v1/agents/adapters/<cli>/` in the daemon, `main/agents/<cli>.ts` in Electron main. The renderer reads per-agent facts from `GET /v1/capabilities` and never spells an agent's name.
- Scope and milestones live in `.geniro/planning/geniro-app-v1/` (local, gitignored).

Stack: TypeScript 6, Node 24.15+, NestJS 12 (Fastify), MikroORM + better-sqlite3, React 19 + Tailwind v4 (electron-vite), pnpm 11 + Turbo, swc, Vitest, ESLint + Prettier.

---

## CodeGraph — prefer it over grep/find

The repo is indexed by CodeGraph (`.codegraph/`, gitignored, always present locally). Use it before grep/find/Read to locate or understand code.

- MCP tool `codegraph_explore` (load it via tool search if deferred), or shell `codegraph explore "<symbols>"` (`-p <path>` for another checkout).
- Query with symbol names, not prose. Prose matches the commonest symbol names (`error`, `status`) and ranks the wrong files first; output is cut after a few files, so ranking is the answer. For a flow, name the symbols that span it.
- `codegraph.json` `deprioritize` lowers stories, `__tests__/`, the generated client and `packages/` in ranking without hiding them; use `exclude` to hide.
- It cannot answer git provenance (`git show origin/main:<file>`), prevalence counts (`grep -c`) or questions about config files. It beats grep for "what consumes this?", since it follows dynamic dispatch.
- In a worktree, pass `projectPath: <worktree root>` to the MCP tool. The server's default project is fixed at launch, so a bare call answers silently from the launch checkout. A user-level hook (`~/.claude/hooks/codegraph-follow-cwd.sh`) fills it in where installed.
- The MCP tool catches up on its own. The shell form does not: run `codegraph sync` first in a worktree no MCP session is watching.
- A worktree without its own `.codegraph/` borrows the main checkout's index (a banner says so); run `codegraph init` there. Never run `init`/`index` just for freshness (full rebuild, ~580 MB).

---

## Commands

Run from the repo root. pnpm only. Run `pnpm install` first.

### Daily development

```bash
pnpm install            # install workspace deps
pnpm rebuild:native     # rebuild better-sqlite3 for Electron's ABI
pnpm build              # turbo: swc for packages + daemon, electron-vite for the UI
pnpm dev                # launch the Electron app; it spawns and supervises the daemon
pnpm daemon:dev         # daemon-only watch loop from TS source under Electron-node
pnpm storybook          # component catalog (dev only, never packaged)
```

- Run `pnpm rebuild:native` after every `pnpm install` and after any Electron or Node version change. The daemon runs under Electron's Node (`ELECTRON_RUN_AS_NODE`), so `better-sqlite3` must match Electron's ABI; without it the daemon and `@packages/mikroorm` tests crash.
- `pnpm daemon:dev` runs `src/main.ts` with `node --watch -r @swc-node/register -r tsconfig-paths/register` under `ELECTRON_RUN_AS_NODE=1 electron`, with `TS_NODE_PROJECT` pointing at the root tsconfig.
- Never move it to `tsx`/esbuild: esbuild emits no decorator metadata, so Nest DI breaks.
- Never add `--watch-kill-signal=SIGKILL`: the default SIGTERM lets Nest shutdown hooks remove the pidfile and reap spawned agents.

### Build, types, lint

```bash
pnpm build              # swc → dist/ (packages, daemon); electron-vite → out/ (UI)
pnpm check-types        # tsc --noEmit per workspace (swc does not type-check)
pnpm lint               # eslint, no fixes
pnpm lint:fix           # eslint + prettier auto-fix
```

### Testing

Always use the package scripts, never `vitest` directly.

```bash
pnpm test:unit                                   # all unit tests
pnpm --filter @geniro/daemon test:unit           # one workspace
pnpm --filter @geniro/ui test:unit src/shared/themes.spec.ts   # one spec, path relative to the workspace
pnpm test:cov                                    # with coverage
```

### Seeding a throwaway profile

```bash
GENIRO_USER_DATA="$HOME/Library/Application Support/Geniro-dev" \
  pnpm --filter @geniro/daemon seed
```

- Fills a database with chats in hard-to-reach UI states. Seeders live in `apps/daemon/src/db/seeders/`.
- Seeds are idempotent and scoped: every fixture id starts `seed-fixture-`, and a run deletes exactly those before writing. Never `deleteAll`. Keep the `em.clear()` after that delete.
- Never touch runtime-owned tables (`usage_events`, `node_state`) from a seed.
- It refuses a real profile (`~/Library/Application Support/Geniro`, `~/.geniro`); `GENIRO_SEED_FORCE=1` overrides.
- Dev-only: `db/seed.ts` and `db/seeders/` are excluded from the build, and `SeedManager` is registered in the seed entry point, never in `mikro-orm.config.ts` (`@mikro-orm/seeder` is a devDependency stripped from the packaged daemon).

### Before finishing any work

```bash
pnpm full-check         # must pass
```

- It chains build → check-types → build:tests → lint:fix → test:unit → test:integration. `build:tests`, `test:integration` and `test:e2e*` are placeholders no workspace implements yet.
- CI (`.github/workflows/ci.yaml`) runs `lint`, not `lint:fix`, so commit any fixes `full-check` made. CI also runs `pnpm build-storybook`, the only gate that compiles story files, and runs `rebuild:native` before `test:unit`.
- `turbo.json` sets `agentGuidance: false`. If turbo ever injects a managed block into `AGENTS.md`, delete it by hand.

### Packaging (macOS)

```bash
node scripts/make-signing-identity.mjs   # once: the release signing certificate
pnpm --filter @geniro/ui build:mac       # DMG + zip into release/dist/
```

- `build:mac` signs with the certificate named by `GENIRO_SIGN_IDENTITY`, ad-hoc without it. An ad-hoc build looks like a new app to macOS and loses every privacy grant, so the release workflow fails rather than ship one. Details: `apps/ui/AGENTS.md` → _macOS packaging_.

### Regenerating the renderer's daemon client

```bash
pnpm generate:api       # daemon OpenAPI → apps/ui/src/renderer/autogenerated/ (committed)
```

- Run after changing any daemon route or wire schema, and commit the diff.
- Needs the daemon built (`pnpm build`) and a JVM. It boots a throwaway daemon on a temp userData dir and never reads a running one; `GENIRO_SWAGGER_URL` points it at a live one explicitly.

### Dependency upgrades & commits

```bash
pnpm run upgrade        # bump workspace deps (ncu, peer-aware) + reinstall
pnpm commit             # conventional commit via commitizen
```

- Use `pnpm run upgrade`, never bare `pnpm upgrade` (that is pnpm's own `update`).
- It holds back `typescript`, `zod` and `nestjs-zod` (`scripts/upgrade.sh` says why). The `fastify` / `socket.io` pins under `overrides` in `pnpm-workspace.yaml` are set by hand to what the Nest platform packages pin; never move them in an upgrade.
- After an upgrade: `pnpm generate:api` must produce an empty diff, `apps/daemon/src/main.boot.spec.ts` must pass, and drive a real chat turn in the app.
- Commits are conventional (`type(scope): subject`); the husky `commit-msg` hook rejects anything else.
- The husky `pre-commit` hook refuses a staged `.ts`/`.tsx` that git would treat as binary (a NUL in the first 8000 bytes). Write the control character as an escape (`\u0000`).
- Never `--no-verify`.

### Database schema

- The daemon syncs the SQLite schema additively at launch (`orm.schema.update({ safe: true })`). There is no Migrator; never hand-write migrations.
- The chat full-text index (`chat_text`, FTS5 over `message`/`reasoning` items) is outside the sync: triggers on `items` keep it current, `ChatTextIndexService.ensure()` builds or repairs it at boot, and `schemaGenerator.skipTables` hides it from the sync. Its DDL in `db/chat-text-index.ddl.ts` is the one allowed raw-SQL exception; change a statement only by bumping its version.

---

## Coding conventions

- No `any`: use specific types, generics, or `unknown` with type guards.
- All imports at the top of the file.
- PascalCase for classes/interfaces/enums/types; camelCase for variables/functions.
- Throw the custom exceptions from `@packages/common` (`NotFoundException`, `BadRequestException`, …). Never swallow errors silently.
- Import shared packages as `@packages/*`.
- Entities use `@mikro-orm/decorators/legacy`, extend `TimestampsEntity`, and declare explicit column types (`@PrimaryKey({ type: 'string' })`, `@Property({ type: 'integer' | 'text' | … })`); swc discovery needs them. Declare dates with the `DateTimeType` class, never `'datetime'` (the string form marks every loaded entity dirty).
- Daemon feature modules: Controller (route + delegation only, one `@Controller` class per file, no module-scope functions) → Service (all logic) → DAO (extends `BaseDao`, injects `EntityManager` from `@mikro-orm/sqlite`) → Entity. HTTP input uses `createZodDto()` DTOs. Module-shared types go in `<name>.types.ts`. Layout: `.claude/rules/daemon-module-structure.md`.
- CLI agent adapters: `.claude/rules/agent-adapters.md`. geniro's MCP tools: `.claude/rules/mcp-tools.md`.
- "Workflow" is the user-facing thing (strings, `Workflow`, `WorkflowsApi`, `WorkflowStoreService`); "graph" is only its DAG shape (executor, validator, edges, canvas, the daemon's `v1/graphs/`).
- Renderer UI follows the design system (see _Design system (renderer)_).

---

## Testing conventions

- Vitest, transformed by swc (`vitest.base.ts`); tests run from source.
- `@geniro/daemon`, `@packages/mikroorm` and `@geniro/ui` run their suites under Electron's Node (`ELECTRON_RUN_AS_NODE`), the runtime the code ships on. The daemon and mikroorm suites open better-sqlite3, so `pnpm rebuild:native` must have run; the UI suite needs Electron's Node APIs, which the system Node can lack (`net.Socket#setTypeOfService` is missing from Node 24.14).
- Unit tests are co-located `*.spec.{ts,tsx}`. Run them through the package scripts, never `vitest` directly.
- Specs are type-checked: `check-types` uses `tsconfig.json`, which includes specs and `__tests__/`. Never narrow it to the spec-excluding `tsconfig.build.json`.
- React component tests put `// @vitest-environment jsdom` on line 1. Wrap module-scope spies used in a `vi.mock` factory in `vi.hoisted(() => ({ … }))`.
- Never skip on a missing env or service; a missing prerequisite fails loudly.
- No flaky tests: fix nondeterminism at the source, never retry around it. Surface any pre-existing failure you meet and propose a fix.
- No false pins (`.claude/rules/testing.md`).

---

## Constraints (local-first & security)

**No cloud service of geniro's own and no remote code paths.** No geniro backend, telemetry, account or sync. geniro never holds a credential of its own, syncs user data anywhere, or talks to a machine on someone else's say-so. Exactly six kinds of outbound call are allowed:

1. **The user's own login, the user's own data.**
   - `main/github-prs.ts` runs the user's `gh` CLI; geniro holds no token and degrades to silence without login or network.
   - cursor's account-spend poll (`CursorAcpAdapter.fetchAccountSpend` via `v1/agents/services/polled-spend.service.ts`) reads the user's `cursor-access-token` from the Keychain and requests one fixed host itself. The token is used for that poll only and never stored. Every failure ends as "no cost reported".
   - The poll runs at most every 60 s while a cursor run is producing items and every 10 min otherwise, at most `CURSOR_USAGE_MAX_PAGES` pages per poll, and never when idle.
2. **geniro's own public release metadata and artifacts**, anonymous, one fixed host: `main/updater.ts`, `main/update-installer.ts`.
3. **An artifact page loading public libraries** from cdnjs, jsDelivr `/npm/` (not `/gh/`), unpkg and Google Fonts (`ARTIFACT_PAGE_CSP` in `apps/daemon/src/v1/agents/utils/artifact-page.ts`).
   - Scripts, stylesheets and fonts only. `connect-src` stays shut and `img-src` is `data:` only.
   - `ARTIFACT_CDN_HOSTS` in `apps/ui/src/main/network-lockdown.ts` is a twin of the CSP: Chromium resolves those hosts by exact name and nothing else.
   - The route sends `Referrer-Policy: no-referrer`, because the page URL carries its key.
   - Do not add the Tailwind Play CDN (`cdn.tailwindcss.com`); pages use the v4 browser build from jsDelivr.
   - The frame's sandbox is `allow-scripts` alone. Links it posts are opened in the user's browser without confirmation (user decision), and main cancels any frame navigation off the artifact route.
4. **The public model price catalog**: the daemon's `ModelPriceCatalog` GETs `MODEL_PRICE_CATALOG_URL` (`https://models.dev/api.json`, a constant) with no credential or user data.
   - At most one refresh per ~12 h, never blocking boot. The last good copy is kept at `<userData>/model-prices.json`; every failure is logged and swallowed.
   - An unlisted model has no price ("not measured", never $0). Tests set `fetchModelPrices: false`.
5. **A CLI vendor's installer, on the user's press** (`main/cli-install.ts`): `curl -fsSL <url> | <shell>` with the one script URL from the CLI's descriptor (`main/agents/<cli>.ts` → `installer`). A constant, never run unasked.
6. **An encrypted artifact page, to a place the user configured, through the user's own CLI** (`apps/daemon/src/v1/shares/`).
   - Only the AES-256-GCM envelope leaves the Mac; the page is encrypted in the daemon and the key travels in the link's `#fragment`, which no browser sends (and, for an agent's own share, in that agent's transcript — see *Storage split*). Never upload plaintext.
   - The destination is one the user added in Settings → Sharing (`gcloud`, `aws`, or their own program as argv, never a shell). geniro holds no credential and runs no host of its own.
   - Only on a press, or by an agent's `show_artifact(share: true)` while the user's "Let agents share pages" switch is on (off by default). A share that failed because the destination's CLI is signed out waits (`awaiting-sign-in`) and is retried once, after the user's own "Sign in to …" press runs that CLI's login (`ShareSignInService`); nothing retries on its own.
   - A revoke (deleting the remote object through the same CLI) also runs unattended from the auto-revoke sweep, only while the user has set `Settings.sharing.autoRevokeAfterDays` (off by default): the daemon's own timer, a minute after it starts and every 6 h.
   - The share routes and settings are desktop only: the gateway stamps proxied requests `x-geniro-via: remote` (`main/remote/daemon-proxy.ts`), the daemon's `DesktopOnlyGuard` refuses them, and a paired device may not write `Settings.sharing`. Accepted by decision: while agents may share, a message sent from a paired device can still ask an agent to share, because the agent's own MCP call is loopback.

**LAN gateway** (`apps/ui/src/main/remote/`, `Settings.remoteAccessEnabled`) is the one inbound exception: the Mac serves the app to the user's own devices on the same network.

- The daemon still binds `127.0.0.1` only; every LAN-facing byte goes through this directory, which reverse-proxies to loopback.
- Nothing reaches the daemon for an unpaired device: `RemoteGateway`'s pairing check (`pairedDevice`) gates `/v1/*`, `/health` and the `/ws` upgrade. The `/ws` upgrade AND the proxied `/v1/*` and `/health` requests check `Origin` (`originAllowed`); an Origin on its scheme's default port is compared with that port.
- The daemon token never leaves the machine: the gateway injects `Authorization`, strips whatever the browser sent, and rewrites the token in a `/ws` upgrade URL. `getDaemonHandle` is `denyRemotely`; `getStatus` is `allowRemotelyRedacted` (token blanked).
- Pairing is a 6-digit code shown on the Mac, rate-limited per address and globally; the global limit rotates the code.
- A `Host` geniro would not hand out is refused (only loopback, private IPv4, link-local/unique-local IPv6, `*.local`). The listener binds IPv4 only.

**Public tunnel** (`apps/ui/src/main/remote/tunnel.ts`): a third-party client the user already has (`cloudflared`, else `ngrok`) pointed at the gateway's loopback side.

- geniro hosts nothing and holds no credential for it.
- Tunnel requests meet the same Host guard, pairing gate, `Origin` check and injected credential.
- The Host widening is a `*.suffix` mask (`extraAllowedHosts`, `wildcardAdmits` in `host-guard.ts`) that exists only while the tunnel does. Never admit a bare `*` or a one-label suffix.
- Opened only by a press at the Mac: `startRemoteTunnel`/`stopRemoteTunnel` are `denyRemotely`. A launch starts with no tunnel; turning remote access off closes it.
- Still not allowed: a relay or rendezvous host of geniro's own, a credential for one, a tunnel opened unasked, or reaching the daemon other than through loopback.

**Other hard rules**

- No Python runtime; the whole stack is TypeScript.
- Secrets live in the macOS Keychain only, never SQLite or a file. The one kind the app stores is a share key (service `geniro.share`, account = share id), written through `/usr/bin/security -i` on stdin so it never rides argv. The loopback token in `daemon.json` is not a user secret.
- Child env: `buildChildEnv` (`utils/child-env.ts`) strips every `GENIRO_`-prefixed key, the daemon's own `ELECTRON_RUN_AS_NODE` (inherited, it makes every Electron app an agent starts boot as plain Node) and every adapter's `auth.isolatedEnvKeys`, then each adapter re-injects only its own `auth.inheritedEnvKeys`. Never un-strip a name: an inherited user credential must not reach another CLI's child.
- Every child process the daemon spawns registers with `ProcessRegistry` (claim → register → auto-unregister on settle). Never spawn an unmanaged child.
- Every detached child group is also recorded in the child journal (`v1/agents/utils/child-journal.ts` → `<userData>/children.json`) inside the spawn helper itself (`defaultSpawn`, `AgentAdapter.runAsProcessGroup`, `runManagedCommand`, `startManagedStream`). The next boot reaps survivors (`services/stranded-child-reaper.service.ts`, first in `main.ts`).
- The reaper never kills on a pid alone: it re-confirms identity through `utils/process-identity`, and leaves an unconfirmable entry alone. A plain short `execFile` utility child is not journaled.
- Run-scoped CLIs carry a deliberate run tag (`GENIRO_RUN_ID` + `GENIRO_RUN_OWNER`, set after `buildChildEnv`'s strip). Archive, delete, the leftover sweep and a run sitting unused for the kept-session window stop what a run's agents left running by that tag, with explicit pids only. The safety rules (never the daemon, pid 1, another uid, anything on an open terminal, system or installed-app executables, the container VM; cap; start-time check) are in `apps/daemon/AGENTS.md` → _Run processes_; never widen the kill past them. The one recorded exception: what a CLI left running when it ended without stopping it is found by the process groups its session recorded while it lived, not by the tag, and is not fenced for being on a terminal (_Run processes_ → Left commands).
- Workflow definitions are YAML; SQLite holds runtime/history only.
- The daemon binds `127.0.0.1` only and gates every non-public route with the per-launch token.
- No tmux or PTY scraping for graph execution. Inspection is a handoff to the user's own terminal (`v1/handoff/`).
- Never use `--no-verify`.

---

## Architecture

```
apps/
  ui/          @geniro/ui           Electron main + preload + React renderer (electron-vite)
  daemon/      @geniro/daemon       NestJS loopback daemon over @packages/http-server + MikroORM SQLite
packages/      vendored from Geniro (see the last section)
  common/      @packages/common     AppBootstrapper, pino logger, exceptions
  http-server/ @packages/http-server NestJS + Fastify host: health, swagger/scalar, helmet, validation
  metrics/     @packages/metrics    Prometheus metrics
  mikroorm/    @packages/mikroorm   TimestampsEntity, BaseDao, MikroOrmModule (SQLite driver)
```

### The daemon (`apps/daemon`)

Full guide: `apps/daemon/AGENTS.md`. Codex loads it only when started inside `apps/daemon`; read it yourself before working there from the root. Cross-cutting facts:

- Binds `127.0.0.1` only, via the http-server extension's `host` / `portFallback` / `onListening` options. Preferred port `47615` (`DAEMON_PREFERRED_PORT`), falling back to a free port.
- Writes the pidfile (`daemon.json`: pid, host, port, per-launch token, version, entry, startedAt) only after the schema sync and a healthy listen, then prints `GENIRO_DAEMON_READY {port}`. The UI reads host/port from the pidfile and never assumes them.
- Shutdown is Nest-owned (`enableShutdownHooks`); `utils/pidfile.lifecycle.ts` clears the pidfile. Do not add signal handling to `main.ts`.
- Config env, set by the UI: `GENIRO_USER_DATA` (fallback `~/.geniro`), `GENIRO_PORT`, `GENIRO_IDLE_EXIT_MS` (absent = never exit). The userData dir holds `geniro.db`, `daemon.json`, `daemon.lock`, `children.json`.
- Auth (`auth/token.guard.ts`): every route needs `Bearer <launch token>` except the public prefixes `/health` and `/v1/artifacts` (`PUBLIC_PREFIXES`, matched at segment boundaries). `/metrics` and `/swagger-api` stay token-gated.
- `/v1/artifacts` is gated by a per-artifact 256-bit key in the URL, because an `<iframe src>` cannot send a header. Never put the launch token in a URL. `ArtifactStoreService.read` requires the key and compares it in constant time.
- `/v1/mcp/<runId>/<nodeId>[/<conversationId>]` also accepts that node's own call token, keyed by `(runId, nodeId)`, revoked at run teardown. No other route accepts it.
- WebSocket: one Socket.IO gateway at `/ws`. The token rides the handshake `auth` payload. The handshake bypasses Nest guards, so every gateway authenticates in `handleConnection` through the shared `enforceWsHandshakeAuth` (`auth/ws-auth.ts`); never write a second copy. `LoopbackTokenGuard` lets `ws` message contexts through and refuses any other non-HTTP transport.

### The UI (`apps/ui`)

Full guide: `apps/ui/AGENTS.md` (main process, renderer, chats, workflows, settings, packaging, notifications, daemon supervision). Codex loads it only when started inside `apps/ui`; read it yourself before working there from the root.

### Agent instructions — the host preamble and the user's own

- Every turn's instruction block is composed at one seam: `AgentAdapter.composeSystemPrompt` → `composeTurnInstructions` (`v1/agents/utils/agent-instructions.ts`). Adapters never join the parts themselves (`.claude/rules/agent-adapters.md`).
- Order, general → specific: host preamble (`GENIRO_UI_PREAMBLE`), the CLI's background-work note (`AdapterConfig.backgroundWork.agentNote`), the user's custom instructions, a board card's `taskInstructions`, wired `instructionBlocks`, the node's `role`, the callee sentence (`ANSWERING_A_CALL`, on every turn that answers a call, a leaf callee included), then the "May call" block.
- The background-work note is per CLI because the truth differs: a claude or cursor turn (and the call it answers) is held while its background sub-agents run and the agent is started again with their reports, so it is told to end its turn rather than poll; a codex turn is not held, so it is told to `wait_agent`. Every sentence must stay true of its adapter's hold; never inject a reminder mid-turn instead (it arrives as a user message).
- Delivery: claude on `--append-system-prompt`; codex as the thread's `developerInstructions`; ACP inside the prompt text, after the user's words, wrapped in `<host-context>` (`HOST_CONTEXT_TAG`). Never lead the ACP prompt with it: the CLI names the chat from the prompt text.
- On ACP the block is sent once per session and re-sent only when its text changes (`apps/daemon/AGENTS.md` → **ACP instruction delivery**).
- The preamble exists to contradict the CLI's own claim that output goes to a terminal. Every claim in it must match this renderer: GFM renders, local-path images render, remote images do not (CSP `img-src 'self' data:`). Never promise remote images or image output blocks, and say nothing about response length.
- `internalProbe` turns get no preamble and no background-work note.
- The Settings screen reads the preamble and the per-CLI notes from `GET /v1/capabilities` (`hostPreamble`, `backgroundWorkNotes`); never restate them in the renderer.
- Custom instructions are one global value, `Settings.customInstructions`, sent on chat create and workflow start under `CustomInstructionsSchema` (no length limit; refuses C0 control characters, since a NUL in argv makes `spawn` throw on every turn).
- They are snapshotted onto `Run.customInstructions`, never read live: `AgentAdapter.sessionKey` hashes them, so a live read would respawn the kept CLI and its MCP servers mid-conversation. Editing them affects the next chat.
- A node's `role` outranks them; keep them as peer fields, not one joined string.
- `POST /v1/chats/forget-custom-instructions` (an explicit Settings button) purges the snapshot from existing runs.

### The daemon API client (generated — never hand-mirrored)

- `pnpm generate:api` emits a typed client (openapi-generator `typescript-fetch`) into `apps/ui/src/renderer/autogenerated/` from the daemon's OpenAPI document: every wire type (`RunDto`, `ItemDto`, `Workflow`, …) plus one API class per swagger tag.
- It is committed, excluded from eslint/prettier, and never edited by hand. The renderer never restates a daemon HTTP shape.
- `renderer/daemon-api.ts` is the only hand-written transport: loopback base URL from the pidfile, per-launch bearer token, request timeout, and the error shape `daemon <METHOD> <path> failed (<status>): <detail>`. `createDaemonApis(handle)` binds every API class; the `DaemonApis` interface is the authoritative list.

Daemon side of the contract (`v1/*`):

- Wire shapes are zod schemas in each module's types file; TS types are `z.infer` of them. Shared schemas carry `.meta({ id })` so they become named OpenAPI components.
- A response DTO's root schema must not carry `.meta({ id })`; `setupSwagger` fails the boot on the resulting dangling `$ref`.
- Declare responses with `@ZodResponse({ status, type })` (nestjs-zod). No `@nestjs/swagger` CLI plugin (swc cannot run it).
- Every controller has `@ApiTags`, `@ApiBearerAuth` and `@ApiOperation({ operationId })`; operationIds are globally unique (`setupSwagger` throws on duplicates).
- `WorkflowSchema` stays default-free so request and response collapse to one type; YAML defaults live in `WorkflowYamlSchema` (`parseWorkflowYaml` only).
- `McpController` is `@ApiExcludeController()`.

### Design system (renderer)

- Rules: `.claude/rules/renderer-design-system.md` (tokens only, never a hardcoded colour, one CSS file per theme) and `.claude/rules/renderer-components.md` (reuse layers, no duplicates, `cn()`/`cva`, no barrels).
- Enforced by the eslint colour override on `apps/ui/src/renderer/**` and `apps/ui/.storybook/**`, and by `components/catalog-coverage.spec.ts` (every component has a co-located story in the same commit).
- Themes, theme application and Storybook: `apps/ui/AGENTS.md` → _Design system_.

### Build toolchain

- swc compiles the daemon and `packages/*` to CommonJS with decorator metadata (`legacyDecorator` + `decoratorMetadata`), from one root `.swcrc`. Entities and Nest DI depend on it.
- electron-vite builds the UI to `out/`.
- `@packages/*` resolve to TypeScript source via the root tsconfig paths, so packages ship no `.d.ts`; type-checking is `pnpm check-types` only.

### Storage split

- **Workflow (graph) definitions → YAML.** Never in SQLite.
  - Workflow backups → `<userData>/workflows/.backups/<slug>.<YYYY-MM-DDTHH-mm-ss>.yaml`, written before every save an analysis applies (`WorkflowChangeService`) and before an approved `propose_workflow` replaces a file (`WorkflowProposalService`). Never named `*.geniro.yaml`, so the library never lists them; restore by copying one over `<slug>.geniro.yaml`.
- **Settings → `settings.json`** in the Electron userData dir. The key list is `apps/ui/AGENTS.md` → **Settings keys (`settings.json`).**
  - Removing or renaming a schema key destroys what it held (`readSettings` keeps only known keys; `writeSettings` rewrites the file). Migrate or export the data first.
  - An unparseable file is copied aside to `settings.json.corrupt-<timestamp>` before any write; never write over a file that cannot be read.
  - Hand-managed lists (`fastActions`, `runConfigs`, `configProfiles`) are salvaged entry by entry on read and keep the user's order.
  - `archiveRetentionDays` defaults to `null` because it arms a sweep that permanently deletes archived chats. The daemon only executes it (`POST /v1/chats/sweep-archived`).
  - `sharing.autoRevokeAfterDays` defaults to `null` because it arms a sweep that revokes shared links. Unlike the archive sweep, the daemon owns its timer (`ShareService.revokeExpired`), so a paired device never runs it.
  - Values whose vocabulary belongs to the daemon stay opaque strings on the Electron side (`shared/contracts.ts` holds no daemon shapes).
- **MCP config → each CLI's own config files**, the one exception to "geniro writes only its own files". Toggles and server definitions are written only on the user's press, through each CLI's own mechanism and lock, refusing an unparseable file and keeping no copy. Rules: `apps/daemon/AGENTS.md` → **MCP config writes**.
- **Secrets → the Keychain only.** Every CLI authenticates from its own login. Share keys are the one secret geniro keeps (see _Constraints_).
- **SQLite (`geniro.db`) → runtime and history only**: `runs`, `items`, `node_state`, and the usage tables.
  - Archive uses its own `archivedAt` column, never `deletedAt`: the `softDelete` filter is global and default-on, so an archived row would vanish from the read that unarchives it.
  - `usage_events`, `usage_activity` and `line_baselines` are exempt from run teardown so lifetime totals survive deleting a chat. `usage_events` is append-only and denormalizes agent/model/folder at write time.
  - `artifact_shares` is exempt too: a shared link outlives its chat, and the row (with the destination it was shared to) is the only way to revoke it. Only a share never uploaded (waiting on sign-in, or failed after it) is dropped with its run, on delete or archive. Its key is in the Keychain, never the row. One accepted exception: an agent's `show_artifact(share: true)` receipt carries the whole link — or, for a share that waited on the user's sign-in, the prompt of the turn the agent is woken with (`HostWakeBus`; its opening row carries no link) — so the key also lives in that agent's transcript: the `items` row of the receipt (readable from a paired device), the CLI's own session file, and the model provider's copy of the conversation — the agent needs the link to place it where it was asked to. `shares_changed` and the sign-in notification never carry it.
- **Pasted images → `<userData>/attachments/<runId>/`.** Only `{id, mediaType}` rides the item payload; never put blobs in the DB.
  - On ACP, send image blocks only to an agent that advertised `promptCapabilities.image`; otherwise send the text plus a `notice` naming what was withheld.
- **Uploaded files (phone) → `<userData>/chat-uploads/<uuid>/<name>`** (`POST /v1/chats/uploads`), collected by the teardown of the run whose user messages name them.
- **Published artifacts → `<userData>/artifacts/<runId>/<artifactId>/v<N>.html`** plus `meta.json` (version, serving key). The `show_artifact` row carries only the descriptor.
  - Every version is kept, because each transcript row opens the version it announced.
  - Local pictures are copied into `images/<sha256>.<ext>` and inlined as `data:` URIs; no route serves a picture to the page. Only png/jpeg/webp/gif/avif judged by bytes, only from `/tmp`, the system temp dir or the run's folder; a refused picture refuses the page.
  - Limits refuse rather than truncate (512KB of HTML). Dropped with the run by `RunTeardownService`.
- **Task worktrees → `<userData>/worktrees/<taskId>/`**, registry `<userData>/worktrees.json` (`apps/ui/src/main/worktree-service.ts`).
  - Every git call belongs to the Electron main process; the daemon runs no git and is only told the path.
  - An unreadable registry reads as empty. Removal is bounded to `<userData>/worktrees/` by path, never by what the file claims.
  - A worktree lives until its card's work is finished (`isWorkFinished`: card Done and no run working), never merely until its run settles.
  - The branch is never removed. Before removing a worktree, main commits uncommitted work onto the task's branch with hooks run. Never invent a git identity; a failed commit keeps the worktree.
- **Persist-then-emit** for streamed, replayable data (chat and graph-node items): allocate the monotonic `seq`, write the row, then publish. Clients replay through an `afterSeq` cursor, so nothing is emitted before it is durable.
- The per-launch token in `daemon.json` is allowed on disk; it is a session token, not a user secret.
- **Debug log → 0600 JSONL** under `<userData>/logs/`, rotated. Every entry is scrubbed of registered secrets (`v1/diagnostics/utils/redact.ts`).
  - Redaction is by registration, never by pattern: register a new credential at its mint site, before it can be logged (the launch token in `main.ts`, inherited CLI credentials in `AgentAdapterRegistry`, call tokens in `CallTokenRegistry.issue()`, share keys in `ShareKeychain` and the artifact key in `ArtifactStoreService`).
  - The `agent-stdio` channel records the user's raw CLI conversation, so it stays off unless switched on.
- **Daemon inspector**: the `daemonInspect` setting (off by default) spawns the daemon with `--inspect=127.0.0.1:9229`. The flag goes before the entry script, or node passes it to the daemon as an argument.

---

## A note on vendored packages

`packages/{common,http-server,metrics,mikroorm}` are copied from the sibling Geniro repo (`/Users/sergeirazumovskij/Desktop/Projects/Geniro/geniro`). Keep changes minimal so fixes can flow between the repos. The deliberate local changes:

- Sentry removed from `common` and the `http-server` exception path; OIDC auth in `http-server` left dormant.
- `mikroorm` driver swapped from Postgres to `@mikro-orm/sqlite`.
- `http-server`: `runHttpApp` / `buildHttpServerExtension` gained `host` / `portFallback` / `onListening` (defaults keep upstream's `0.0.0.0`); `setupSwagger` gained an optional `swagger.guard(authorization)`; `utils/openapi-schemas` canonicalizes duplicate components and fails boot on a dangling `$ref`.
- `http-server`'s `redactSecretQueries` masks the artifact page's `key` parameter; keep that name in any fix that flows back.
- `mikroorm`'s `BaseDao.hardDeleteIncludingSoftDeleted`: a separate method so the destructive purge is never reachable through an option.
- `mikroorm`'s `TimestampsEntity` declares its dates with the `DateTimeType` class (the `'datetime'` string makes every loaded entity dirty and re-dates rows on flush).
