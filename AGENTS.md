# AGENTS.md

This file provides guidance to AI coding agents — Claude Code, Codex, Cursor — working with code in this repository.

**The guidance lives in `AGENTS.md` files — this one, `apps/daemon/AGENTS.md` and `apps/ui/AGENTS.md` — so every CLI reads the same text, and each directory's `CLAUDE.md` is ONE line, `@AGENTS.md`, that imports it.** Why:

- **Codex** reads `AGENTS.md` alone, never a `CLAUDE.md`, from the repository root down to the directory it was started in — and only the first 32 KiB of that chain by default (`project_doc_max_bytes`).
- **Cursor** reads `AGENTS.md` at every level, and `CLAUDE.md` only behind a setting.
- **Claude Code** delivers a NESTED `AGENTS.md` through a hook whose output is capped, so a large one arrives as a short preview; a nested `CLAUDE.md` that imports it arrives whole.

So: **write guidance in `AGENTS.md`, never in a `CLAUDE.md`**, and keep every `CLAUDE.md` exactly `@AGENTS.md`. A guide added in a new directory gets both files. Claude Code is the only one of the three that reads `.claude/rules/` — see *Repository rules* below for how the others reach them. The rule sections of this file (through *Constraints*) sit ahead of *Architecture* so they fall inside Codex's 32 KiB; keep them there.

**Contents**: [Repository rules](#repository-rules) · [Issues and pull requests](#issues-and-pull-requests) · [Project Overview](#project-overview) · [CodeGraph](#codegraph--prefer-it-over-grepfind) · [Commands](#commands) · [Coding conventions](#coding-conventions) · [Testing conventions](#testing-conventions) · [Constraints (local-first & security)](#constraints-local-first--security) · [Architecture](#architecture) · [A note on vendored packages](#a-note-on-vendored-packages)

---

## Repository rules

The rules under `.claude/rules/` are part of this file's contract, each scoped to the paths it governs. **Claude Code loads a rule by itself** when a file under its paths is touched (its `paths:` frontmatter). **Codex and Cursor read no `.claude/rules/` at all**, so on either of them, open the matching rule and follow it BEFORE you edit a file under its paths:

| Rule | Applies to | What it holds |
| --- | --- | --- |
| [`.claude/rules/daemon-module-structure.md`](.claude/rules/daemon-module-structure.md) | `apps/daemon/src/**` | The directory layout every daemon feature module follows: thin controllers, types files, the `__tests__/` boundary, and twin parsers |
| [`.claude/rules/database-queries.md`](.claude/rules/database-queries.md) | `apps/daemon/src/**` | Every daemon query through MikroORM's QueryBuilder or its typed Kysely builder — never hand-written SQL; transactions use their own `EntityManager` |
| [`.claude/rules/agent-adapters.md`](.claude/rules/agent-adapters.md) | `apps/daemon/src/v1/agents/**` | CLI agent adapters: every fact about a CLI lives in its own adapter; ACP first |
| [`.claude/rules/mcp-tools.md`](.claude/rules/mcp-tools.md) | `apps/daemon/src/v1/mcp/**`, `apps/daemon/src/v1/agents/utils/host-*.ts` | geniro's own MCP tools: one directory per tool, the shared base class and interface, how to add or change one |
| [`.claude/rules/renderer-components.md`](.claude/rules/renderer-components.md) | `apps/ui/src/renderer/**` | Reuse layers (token → primitive → shared component), no duplicates, the component catalog |
| [`.claude/rules/renderer-design-system.md`](.claude/rules/renderer-design-system.md) | `apps/ui/src/renderer/**`, `apps/ui/.storybook/**` | Styling from design tokens only, never a hardcoded colour; one file per theme |
| [`.claude/rules/renderer-stories.md`](.claude/rules/renderer-stories.md) | `apps/ui/src/renderer/**/*.stories.tsx`, `apps/ui/.storybook/**` | Storybook story conventions: co-located stories, catalog namespaces, the `window.geniro` stub, theme decorator |
| [`.claude/rules/renderer-overlay-primitives.md`](.claude/rules/renderer-overlay-primitives.md) | `apps/ui/src/renderer/components/ui/menu.tsx`, `apps/ui/src/renderer/components/ui/popover.tsx`, `apps/ui/src/renderer/components/ui/dialog.tsx`, `apps/ui/src/renderer/components/ui/context-menu.tsx` | Placement internals of the menu/popover/dialog primitives: shift before clamp, two-commit placement |
| [`.claude/rules/packaging-config.md`](.claude/rules/packaging-config.md) | `scripts/**`, `apps/ui/electron-builder.yml` | Packaging config: an env-signal branch owns every value it controls |
| [`.claude/rules/testing.md`](.claude/rules/testing.md) | `**/*.spec.ts`, `**/*.spec.tsx` | No false pins: a claimed behaviour has an assertion that fails when it breaks |

**A new rule file is added to this table in the same change**, with the same paths its frontmatter declares. That table is the only way the rule reaches Codex and Cursor.

---

## Issues and pull requests

Agents are welcome to file issues and open pull requests here. The human version is [`CONTRIBUTING.md`](CONTRIBUTING.md).

**Filing an issue.** Search first (`gh issue list -R geniro-io/geniro-app --state all --search "<words>"`) and comment on a match instead of opening a duplicate. The issue forms in `.github/ISSUE_TEMPLATE/` are a web-only UI, so from `gh issue create` or the API write the body with the SAME `###` headings the form would produce. Pass `--label bug` or `--label enhancement`; GitHub drops labels from accounts without triage access, which is fine. Never paste a debug log without reading it: it can hold paths and, with `agent-stdio` on, the user's conversation.

- **Bug** — `### Geniro version`, `### macOS version and chip`, `### Which agent was involved?` (claude / cursor-agent / codex / a workflow / none), `### Agent CLI version`, `### Steps to reproduce`, `### What happened, and what did you expect?`, `### Debug log`, `### Anything else?`. Write "unknown" rather than guessing a version.
- **Feature** — `### What problem are you trying to solve?`, `### What would you like to happen?`, `### What do you do today instead?`, `### Would you like to work on it?`. A request that needs a cloud service, telemetry or an account is out of scope (see *Constraints*).

These heading lists are TWINS of the form fields: change a form's labels and change them here in the same commit.

**Opening a pull request.**

1. Work on a branch, never on `main` — it only accepts pull requests (a ruleset requires one, plus the `CI Pass` check). Without push access, fork: `gh repo fork geniro-io/geniro-app --clone`, push to the fork, and `gh pr create -R geniro-io/geniro-app`.
2. **The PR title is the release.** Pull requests are squash-merged, so the title becomes the commit on `main` and semantic-release reads it: `type(scope): subject` (`fix(ui): …`, `feat(daemon): …`). Commit messages follow the same format — the `commit-msg` hook enforces it. Never `--no-verify`.
3. **Every pull request uses `.github/pull_request_template.md`** — the maintainer's, an outside contributor's and every agent's, with no house format beside it. `gh pr create --body` REPLACES the template rather than filling it, so reproduce its headings yourself, in order: `## Why` (with `Closes #N` when there is an issue), `## What changed`, `## How it was verified`, `## Not in this PR` ("nothing" when empty), `## AI assistance`, `## Checklist`. Tick a checklist box only for what was actually done, and name the agent under `## AI assistance`. These headings are TWINS of the template: change one, change the other in the same commit.
4. Before pushing, `pnpm full-check` must pass (see *Commands*), and any fixes its `lint:fix` made are committed — CI runs `lint` without fixing. A changed daemon route or wire schema also needs `pnpm generate:api` and the regenerated client committed.
5. One concern per pull request; open it as a draft (`--draft`) while it is unfinished. A first-time contributor's CI waits for a maintainer to approve the run.

**Where each check runs.** The app is macOS-only, but the gates are not: CI runs them on `ubuntu-22.04` with no display (sequence under *Before finishing any work*), so a Linux cloud sandbox can run `pnpm full-check` — provided it can download the Electron binary, since the `@geniro/daemon` and `@packages/mikroorm` unit suites run under Electron; a sandbox whose egress blocks that download cannot run those suites. One spec file is `pnpm --filter @geniro/ui test:unit src/shared/themes.spec.ts` (the same shape for `@geniro/daemon`, paths relative to the workspace) — never `vitest` directly. `pnpm generate:api` additionally needs a JVM. Driving the real UI on headless Linux is the `run-desktop` skill (`.claude/skills/run-desktop/`); on a Mac it is `pnpm dev`.

**Never, in a contribution:** commit a credential, token or `.env` file; hand-edit `apps/ui/src/renderer/autogenerated/` (regenerate it); add a cloud service, telemetry or an account (see *Constraints*); reformat or restructure code the change does not need — a vendored `packages/*` file especially, since those are kept close to their upstream; or delete a persisted settings key without migrating what it holds (see *Storage split*).

---

## Project Overview

**geniro-app** is a **local-first macOS desktop app** for composing and running a **DAG of CLI coding agents** as a team — a from-scratch rewrite of Geniro that marries Geniro's graph engine with a CLI-agent execution layer. **Everything runs on the user's machine, no cloud.**

The app is an **Electron UI** that also supervises a **bundled local daemon** over loopback. The daemon is an `apps/api`-style **NestJS** app built on packages **vendored from the Geniro monorepo** and adapted for local-first use (SQLite instead of Postgres, no Sentry/Redis/cloud, loopback-only).

**Tech stack**: TypeScript 6.x, Node.js 24+, NestJS 12 (Fastify), MikroORM (`@mikro-orm/sqlite` / better-sqlite3), React 19 + Tailwind CSS v4 (electron-vite renderer), pnpm 11 + Turbo 2.11 monorepo, swc (daemon + packages) / electron-vite (UI), Vitest 5, ESLint 10 + Prettier 3.

**Status**: all four v1 milestones (M1–M4) are built. The plan and milestones live in `.geniro/planning/geniro-app-v1/` (`spec.md` + `milestone-1..4.md`) — the authoritative source for scope and sequencing; `.geniro/planning/` is local working state, gitignored.

**Agents** are driven **headlessly via their CLIs only** — `claude -p`, `cursor-agent` over its first-party **ACP** server (`cursor-agent acp`), and OpenAI's `codex` over its own JSON-RPC server (`codex app-server` — codex ships no ACP server). No SDKs, no LangGraph host-side, no Python. **Every fact about one of them lives in that CLI's own adapter directory** (`v1/agents/adapters/<cli>/` in the daemon, `main/agents/<cli>.ts` in the Electron main process); everything else composes over the adapter registry and the capabilities it publishes, and the renderer reads per-agent facts (names, icons, approval modes, options) off `GET /v1/capabilities` rather than spelling an agent's name.

---

## CodeGraph — prefer it over grep/find

This repo is indexed by **CodeGraph** (`.codegraph/` at the repo root — gitignored, always present locally, and to be kept in use). To understand or locate code, reach for it **before** grep/find or opening files:

- **MCP tool** (preferred): `codegraph_explore` returns the relevant symbols' verbatim, line-numbered source plus the call paths between them, including dynamic-dispatch hops grep can't follow. If it is listed but **deferred**, load it by name via tool search rather than treating it as unavailable.
- **Shell** (always works): `codegraph explore "<symbol names>"`; `-p <path>` aims it at another checkout.

Fall back to grep/Glob/Read only when CodeGraph has no answer (non-code files, or code still missing after the worktree checks below).

**ASK IN SYMBOL NAMES, NOT PROSE.** Query tokens are matched against symbol NAMES, so a sentence becomes a bag of the commonest names (`error`, `failed`, `status`, `session`) and ranks whatever files define those first — and the output is cut after ~3 files, so the order IS the answer. Name the symbols spanning a flow (`ClaudeTurnDriver mapClaudeMessage errorDetail`, `mutateElement renderScene`). A PascalCase token biases an overloaded name toward that type's own definition. `maxFiles` (default 12) widens how much source is shown; it does not rescue a query that ranked the wrong files.

**`codegraph.json` at the repo root carries `deprioritize`** — the stories, `__tests__/`, the generated client and the vendored `packages/` stay indexed and findable but stop outranking product code. It changes rank, never visibility; reach for `exclude` when something should be gone. Needs codegraph ≥ 1.6.0.

**What it cannot answer** — don't spend a call on these: git provenance ("was this already on `main`?" → `git show origin/main:<file>`), repo-wide prevalence counts (`grep -c`), and config files. Where it beats grep outright: **"does anything consume this?"** — blast radius follows dynamic dispatch.

**In a worktree**, pass `projectPath: "<absolute worktree root>"` on every MCP call — without it the server answers from the checkout the session was launched in, uncommitted work included, with nothing saying which tree. The MCP tool catches up on its own; the shell form reads the index as it stands, so run `codegraph sync` first there. A worktree with no `.codegraph/` of its own borrows the main checkout's index (a banner says so) — run `codegraph init` in it. Never use `init`/`index` just for freshness: both are full rebuilds.

---

## Commands

All commands run from the **repo root** unless noted. **Always run `pnpm install` first.** **pnpm only** — never `npm install` or `yarn` in this workspace: npm prunes the pnpm tree (repair: `pnpm install --force`).

### Daily development
```bash
pnpm install            # install workspace deps
pnpm rebuild:native     # rebuild better-sqlite3 against Electron's ABI (required; see note)
pnpm build              # build everything (turbo → swc for packages+daemon, electron-vite for the UI)
pnpm dev                # launch the Electron app (electron-vite) — spawns + supervises the daemon
pnpm daemon:dev         # daemon-only watch loop: runs TS source via @swc-node/register under Electron-node, restarts on save
pnpm storybook          # the component catalog (dev only; never packaged) — also View → Component Catalog in the app
```

`pnpm rebuild:native` is required because the daemon runs under Electron's bundled Node (`ELECTRON_RUN_AS_NODE`), so its native `better-sqlite3` must be built for Electron's ABI, not the host Node ABI. Run it right after every `pnpm install`, and again whenever the native ABI changes — an Electron or Node version bump, or a fresh clone. Skipping it also breaks the `@geniro/daemon` and `@packages/mikroorm` unit tests — see *Testing conventions*.

`pnpm daemon:dev` mirrors Geniro `apps/api`'s `start:dev`: node's built-in `--watch` + `-r @swc-node/register -r tsconfig-paths/register` running `src/main.ts` directly (`TS_NODE_PROJECT` points at the **root** tsconfig so the `@packages/*` paths resolve). No build step and no `dist/` in dev — edits to `apps/daemon/src` *and* `packages/*/src` restart the daemon with fresh code. Deliberate deviations from Geniro: the runtime is `ELECTRON_RUN_AS_NODE=1 electron` (host Node's ABI can't load the Electron-built `better-sqlite3`), and there is no `--watch-kill-signal=SIGKILL` (the default SIGTERM lets Nest shutdown hooks run — pidfile cleanup + `ProcessRegistry` reaping of spawned agent children). It must **not** be moved to `tsx`/esbuild: esbuild does not emit `emitDecoratorMetadata` (no `design:paramtypes`), so NestJS type-based DI cannot resolve under it.

### Build, types, lint
```bash
pnpm build              # turbo run build (swc → dist/ for packages & daemon; electron-vite → out/ for the UI)
pnpm check-types        # turbo run check-types (tsc --noEmit per package — swc does NOT type-check)
pnpm lint               # eslint, no fixes
pnpm lint:fix           # eslint + prettier auto-fix
pnpm lint:packages      # lint over packages/* only
```

### Testing
Always use the package.json scripts — never call `vitest` directly.
```bash
pnpm test:unit                             # all unit tests (vitest, *.spec.{ts,tsx})
pnpm --filter @geniro/daemon test:unit     # just the daemon
pnpm --filter @geniro/ui test:unit         # the UI
pnpm --filter @geniro/daemon test:graph    # just the daemon's src/v1/graphs specs
pnpm test:packages                         # the packages/* suites only
pnpm test:cov                              # test:unit with coverage; also filterable per-workspace
```

### Seeding a throwaway profile
```bash
GENIRO_USER_DATA="$HOME/Library/Application Support/Geniro-dev" \
  pnpm --filter @geniro/daemon seed
```

Fills a database with conversations that put the chat surface's harder states on screen (several pull requests open at once, detached commands still running, a title long enough to fight the header for room). `db/seeders/` holds them (`DatabaseSeeder` composes, `UiFixturesSeeder` supplies).

- **Seeds are IDEMPOTENT and SCOPED**: every fixture run carries a `seed-fixture-` id and each run deletes exactly those before writing, so re-seeding replaces rather than accumulates and a real conversation in the same database is untouched — never `deleteAll`. `em.clear()` after that delete is load-bearing: the identity map still holds what was deleted, so the flush would otherwise UPDATE rows that no longer exist and a re-seed writes no runs.
- **Runtime-owned tables are not a seed's to touch** — `usage_events` is an append-only spend ledger, `node_state` is the executor's.
- **It refuses a real profile by name** (`~/Library/Application Support/Geniro`, `~/.geniro`), because seeding writes conversations nobody asked for and there is no undo; `GENIRO_SEED_FORCE=1` is the deliberate override.

It is a DEVELOPMENT tool and never ships: `db/seed.ts` and `db/seeders/` are excluded from the swc build and from `tsconfig.build.json`, and `SeedManager` is registered in that entry point, never in `mikro-orm.config.ts` — the config is what `main.ts` imports, `@mikro-orm/seeder` is a devDependency, and `pnpm deploy --prod` strips it, so a packaged daemon would fail to boot. It runs under `ELECTRON_RUN_AS_NODE` like `dev` and `test:unit`, never through `mikro-orm seeder:run`, whose host-Node process cannot open the Electron-ABI `better-sqlite3`.

### Before finishing any work
```bash
pnpm full-check         # must pass before finishing
```

`turbo.json` sets `agentGuidance: false`; without it turbo injects (and re-adds) a managed block of its own into `AGENTS.md` whenever it detects an AI agent. The opt-out does not remove a block already written, so if one ever appears, delete it by hand.

`full-check` chains build → check-types → build:tests → lint:fix → test:unit → test:integration. `build:tests` and `test:integration` are **no-op placeholders** — declared in `turbo.json` so turbo doesn't error, but no package implements them and no `*.int.ts` exist — so it effectively gates build + types + lint + unit tests. `test:e2e` / `test:e2e:local` are the same kind of placeholder.

CI is `.github/workflows/ci.yaml`: install → `build:packages` → `build` → `check-types` → `build:tests` → `lint` (not `lint:fix`), then, in its own unit-tests job, `rebuild:native` → `test:unit`, with a `ci-pass` job gating on all of it; it also runs `pnpm build-storybook`, the only gate that compiles the story files.

### Packaging (macOS)
```bash
node scripts/make-signing-identity.mjs   # once, ever: the release signing certificate
pnpm --filter @geniro/ui build:mac       # scripts/build-mac.mjs → DMG + zip into release/dist/
```

`build:mac` signs with the certificate named by **`GENIRO_SIGN_IDENTITY`** and is ad-hoc without it. That is not cosmetic: macOS records every privacy grant against the app's designated requirement, and an ad-hoc signature's requirement is the hash of its own bytes — so an ad-hoc release presents itself as a new app and re-asks for every permission. The release workflow FAILS if the certificate is missing rather than shipping an unsigned artifact. See *macOS packaging* in `apps/ui/AGENTS.md`.

### Regenerating the renderer's daemon client
```bash
pnpm generate:api       # daemon OpenAPI → apps/ui/src/renderer/autogenerated/ (committed)
```
Run after changing any daemon route or wire schema. Needs the daemon BUILT (`pnpm build`) and a JVM (openapi-generator-cli); it boots a throwaway daemon on a temp userData dir and NEVER reads a running one (see *Regenerating* under *The daemon API client*).

### Dependency upgrades, releases & commits
```bash
pnpm run upgrade        # bump every workspace dep to latest (ncu, peer-aware via .ncurc) + reinstall
pnpm commit             # conventional commit via commitizen
```
`pnpm run upgrade`, never bare `pnpm upgrade`: pnpm 11 reads that as its own built-in `update` and never reaches the script. The script holds `typescript`, `zod` and `nestjs-zod` back on purpose — `scripts/upgrade.sh` says why and when each hold lifts — and never moves the exact `fastify` / `socket.io` pins under `overrides` in `pnpm-workspace.yaml`, which are set by hand to what the Nest platform packages pin. After any upgrade, `pnpm generate:api` must still produce an empty diff, and `apps/daemon/src/main.boot.spec.ts` — the one spec that boots the real Nest container from source — must pass: it catches a DI or OpenAPI boot break, a gateway message handler that throws, the swagger gate, and a shutdown that hangs. Neither runs an agent, so drive the real app through a chat turn too.

`pnpm up-versions` runs a local `semantic-release --no-ci` — maintainer-only; agents never run it.

Commit messages must be **conventional** (`type(scope): subject`) — the `commit-msg` husky hook runs commitlint and rejects anything else. `pnpm commit` (commitizen) is the easy way to get the format right.

The **`pre-commit`** hook refuses any staged `.ts`/`.tsx` whose blob git would classify as **binary** — a NUL in its first 8000 bytes. Such a file has no diff, no inline review comments and no three-way merge, and tests and types pass either way, because the raw byte and its `\u0000` escape are the identical code unit at runtime. If it fires, find the control byte and write it as the escape. It reads the INDEX, so a partially staged file is judged by the version being committed.

> Database: the daemon **syncs the SQLite schema additively on launch** (`orm.schema.update({ safe: true })` in `main.ts` — never destructive). There is **no Migrator / migration files**: `db/mikro-orm.config.ts` declares no `migrations` key, and the versioned migration workflow is deferred past v1. Do not hand-write migrations.
>
> The one table the schema sync does not own is the **chat full-text index** (`chat_text`, SQLite FTS5 over every `message` and `reasoning` row, behind `GET /v1/chats/search` and the agents' `search_chats` / `read_chat_context` tools): `ChatTextIndexService.ensure()`, called in `main.ts` right after the sync, builds it and rebuilds it whenever a trigger is missing. Its DDL (`db/chat-text-index.ddl.ts`) and how to change it are in `.claude/rules/database-queries.md`.

---

## Coding conventions

- **No `any`** — use specific types, generics, or `unknown` + type guards.
- **All imports at the top** of the file.
- **Naming**: PascalCase for classes/interfaces/enums/types; camelCase for variables/functions.
- **Errors**: throw the custom exceptions from `@packages/common` (e.g. `NotFoundException`, `BadRequestException`). Never swallow errors silently.
- **Shared packages** are aliased as `@packages/*` (e.g. `import { … } from '@packages/common'`), resolving to each package's `src`.
- **Entities** use `@mikro-orm/decorators/legacy` decorators, extend `TimestampsEntity` from `@packages/mikroorm`, and declare **explicit column types** (`@PrimaryKey({ type: 'string' })`, `@Property({ type: 'integer' | 'text' | … })`) — MikroORM's discovery needs them under swc. A date is declared with the **`DateTimeType` class, never the `'datetime'` string** (see *A note on vendored packages*): the string form makes every loaded entity read as modified, so a flush re-dates rows nothing touched.
- **New daemon feature modules** follow the layered structure: Controller (route + delegation only — ALL business logic in services, a controller file holds exactly one `@Controller` class with no module-scope functions) → Service (business logic) → DAO (extends `BaseDao`, injects `EntityManager` from `@mikro-orm/sqlite`) → Entity. Use Zod DTOs via `createZodDto()` from `nestjs-zod` for HTTP input. Module-shared types/interfaces are declared in the module's root types file (`<name>.types.ts`), never inline in a service/controller file.
- **Daemon module directory layout**: a module keeps only `<name>.module.ts` + its types file at the root; every other file lives in its kind-directory (`controllers/`, `services/`, `dao/`, `entity/`, `dto/`, `utils/`, `adapters/`, `gateways/`, `tools/` in `v1/mcp`, and `__tests__/` for shared test helpers), with specs co-located. Never a flat module. The full rule is `.claude/rules/daemon-module-structure.md`.
- **CLI agent adapters**: every fact about a specific CLI lives in that CLI's own adapter layer (a field of its `AdapterConfig` or an abstract method on `AgentAdapter`) — never in a branch elsewhere in the daemon — and ACP is the preferred transport for any new agent; mechanized in full in `.claude/rules/agent-adapters.md`.
- **geniro's own MCP tools** (the "skills" agents call — `call_agent`, `show_chart`, `propose_plan`, …): one directory per tool under `apps/daemon/src/v1/mcp/tools/<tool>/`, over the shared `BaseMcpTool` / `McpTool` and registered in `createMcpTools` — for editing a tool as much as adding one. The file layout and the rest are in `.claude/rules/mcp-tools.md`.
- **"Workflow" is the thing, "graph" is its shape.** A workflow is what the user makes, names, opens and runs — every user-visible string says so, and so does the entity in code (`Workflow`, `WorkflowsApi`, `WorkflowStoreService`). `graph` is reserved for the DAG inside one: the executor, the topological order, the validator, the edges, the canvas. So the renderer's screen is `workflows/Workflows.tsx` while the daemon's engine module stays `v1/graphs/`. See *Workflows* in `apps/ui/AGENTS.md`.
- **Renderer UI follows the design system** (see *Design system (renderer)* below): colours come from tokens only, and reusable UI is always a shared component, never re-implemented inline; mechanized in `.claude/rules/renderer-design-system.md` + `.claude/rules/renderer-components.md`. Lint catches a bracketed Tailwind arbitrary colour (`bg-[#fff]`, `bg-[rgb(…)]`, …) and an exact `#hex` string literal; a bare `rgb()`/`hsl()`/`oklch()` string (e.g. in `style={{}}`) is NOT caught by lint and is review-only.

---

## Testing conventions

- **Vitest**, transformed by **swc** (`vitest.base.ts` — `unplugin-swc` + `tsconfigPaths`). Tests run from source; no build step needed.
- **`@geniro/daemon` and `@packages/mikroorm` run their vitest suite under Electron**, so `pnpm rebuild:native` must have already run against Electron's ABI — on a host-ABI tree, `base.dao.spec.ts` fails and segfaults the runner (exit 139) instead of reporting an ordinary test failure. That is why CI runs `rebuild:native` inside its own unit-tests job.
- **Unit tests** are co-located as `*.spec.{ts,tsx}` next to the source. Run with `pnpm test:unit`, or target one workspace with `pnpm --filter <name> test:unit`. **Never** call `vitest` directly.
- **Specs are TYPE-CHECKED.** `pnpm check-types` runs `tsc --noEmit -p tsconfig.json` in every workspace, and that project includes `src/**` — specs and `__tests__/` helpers with it. (`tsconfig.build.json`, which excludes both, is for the swc build's file list only; it is never the type gate.) Vitest transpiles through swc and checks nothing, so a spec left out of the gate can assert against a shape the daemon no longer has and stay green. Never narrow a workspace's `check-types` back to a spec-excluding project.
- **React component tests** (UI renderer) must put `// @vitest-environment jsdom` on line 1 — the default project environment is `node`. When a `vi.mock(...)` factory closes over module-scope spies, wrap them in `vi.hoisted(() => ({ … }))`.
- **Must-fail policy**: tests never conditionally skip on missing env/services — a missing prerequisite must fail loudly, not `it.skip`.
- **No flaky tests**: nondeterminism is a bug to fix at the source, not retry around. When any pre-existing problem (failing test, broken local step, latent bug) surfaces mid-task, surface it and propose a fix — never silently skip it.
- **No false pins** (mechanized in `.claude/rules/testing.md`): a test whose name or comment claims to pin a behavior must FAIL when that behavior is reverted; assert the real observable, never a proxy the test itself fabricated; and a defensive branch worth writing is worth a test that enters it.

---

## Constraints (local-first & security)

These are hard rules for v1:

- **No Python runtime.** The entire stack — including the CLI-agent layer — is TypeScript.
- **Every child process the daemon spawns registers with `ProcessRegistry`** (claim → register → auto-unregister on settle) so `OnApplicationShutdown` and explicit cancel terminate it — never spawn an unmanaged child. The shutdown path only removes the pidfile and the UI's `SIGKILL` escalation bypasses Nest hooks, so an unregistered child orphans mid-turn (the graph engine spawns N agents).
- **The daemon binds loopback (`127.0.0.1`) only** and gates every non-public route with the per-launch bearer token. Unchanged by the LAN gateway above, which is a SECOND listener in the Electron main process: reaching the daemon from the network still means going through it, under its Host guard and its pairing gate.
- **No tmux / PTY-scraping for graph execution** in v1. A click-through PTY mirror was built and removed because it could not follow a running turn; do not reintroduce it — inspection is handing the conversation off to the user's own terminal (`v1/handoff/` in `apps/daemon/AGENTS.md`).
- **Never use `--no-verify`** when committing.
- **Graph definitions are YAML** (the source of truth). SQLite holds runtime/history only — never graph definitions.
- **Secrets live in the macOS Keychain only** — never in SQLite, never in a file. (The per-launch loopback session token in `daemon.json` is not a user secret and is allowed on disk.) The app currently stores **no secrets at all** — every CLI carries its own login — so this is policy awaiting its next case. When the daemon spawns an agent/child process it builds the child env by **stripping every `GENIRO_`-prefixed key** — daemon config travels as `GENIRO_<NAME>` (e.g. `GENIRO_USER_DATA`, `GENIRO_CLI_PATHS`) — **plus every CLI's own credentials and account-identifying names** (each adapter's `AdapterConfig.auth.isolatedEnvKeys` — the Anthropic keys and `CLAUDE_CONFIG_DIR`, `CURSOR_API_KEY`, `OPENAI_API_KEY`/`CODEX_*` — registered with `utils/child-env.ts` by `AgentAdapterRegistry` as it is built, through each adapter's own `registerEnvIsolation`), and **re-injects only what a given child is entitled to**: each adapter hands its own child just its `auth.inheritedEnvKeys`, i.e. a credential the user exported in their own shell for that CLI alone. The strip is what makes this true: those credentials are ones the daemon INHERITED, so leaving any unstripped would hand the user's own credential to the wrong agent.
- **Every DETACHED child group is also written to the child journal** (`v1/agents/utils/child-journal.ts` → `<userData>/children.json`), and the next boot reaps whatever survived (`services/stranded-child-reaper.service.ts`, called first in `main.ts` before the schema sync so no turn can race it). `ProcessRegistry` is in memory and serves only the GRACEFUL path; a SIGKILL skips Nest's hooks and a `detached` group is not in the daemon's process group, so it is reparented to launchd and runs until reboot. Recording happens inside the spawn helpers themselves (`defaultSpawn` in `utils/spawn-cli.ts`, and `AgentAdapter.runAsProcessGroup`, whose `mcp list` launches the user's own MCP servers) — the pid exists there and nowhere earlier, and a later record leaves a window where a group runs unrecorded. The reaper **never kills on a pid alone**: each entry is re-confirmed through `utils/process-identity` first, because a recorded pid may by then be the user's own interactive `claude`; unconfirmable entries are left alone — a surviving stray costs memory, a mistaken SIGKILL costs the user's work. The journal's OWNER is confirmed the same way (`ownerStartedAt`, journal version 2), since a recycled owner pid would otherwise read as a live previous daemon and its strays be lost. A plain `execFile` utility child is deliberately NOT journaled (single pid, node's own timeout, exits in under a second).

- **No cloud SERVICE of geniro's own, and no remote or multi-machine code paths.** Everything geniro runs, stores and computes is on the user's machine: there is no geniro backend, no telemetry, no account, and nothing syncs between machines. Only these shapes of outbound call are allowed — they are genuinely different, and one predicate covering them would either condemn a shipped feature or permit any HTTP GET at all:

  1. **The user's own credential, the user's own data.** `main/github-prs.ts` runs the user's `gh` CLI against their own repositories: geniro holds no token, borrows a login the user already made, and degrades to silence when that login or the network is absent. cursor's account-spend poll (`CursorAcpAdapter.fetchAccountSpend`, driven by the generic `v1/agents/services/polled-spend.service.ts` for any CLI whose `AdapterConfig.usage.polledSpend` is set) goes one step further: it reads the user's own `cursor-access-token` out of the Keychain and makes the request ITSELF. It is admitted because the figure exists nowhere else (cursor-agent reports no usage on the ACP wire or on disk, and the amount is not derivable from tokens). Its bounds: ONE fixed host, the user's own account, one poll covering every conversation rather than a request per turn, the token used for that poll and never stored, and every failure — no Keychain item, a denied prompt, a signed-out account, no network — ending as the "no cost reported" dash. Cadence floors: ten minutes for the ambient trigger (a thread was opened) and sixty seconds while a cursor run is producing items (Cursor bills per REQUEST, so the figure moves mid-turn) — at most 60 POLLS an hour while an agent works and 6 otherwise, each poll walking at most `CURSOR_USAGE_MAX_PAGES` pages. An idle machine polls nothing, and a claude-only user polls nothing ever.
  2. **An anonymous read of geniro's OWN public release metadata and artifacts**, from one fixed host: `main/updater.ts` (the releases feed) and `main/update-installer.ts` (the checksums and the archive). No credential, no user data, nothing the user chose.
  3. **An artifact PAGE loading a public library from a fixed list of CDNs** (`ARTIFACT_PAGE_CSP` in `apps/daemon/src/v1/agents/utils/artifact-page.ts`: cdnjs, jsDelivr's `/npm/` path, unpkg, and Google Fonts) — the user's decision, so an agent's page can draw with ECharts, Mermaid or Tailwind; such a page does not draw offline. Its bounds:
     - It is the PAGE's request, made by the browser frame — geniro itself fetches nothing and the daemon serves nothing it did not store.
     - Scripts, stylesheets and fonts only: `connect-src` stays shut, so neither the page's code nor a library can `fetch` or open a socket, and `img-src data:` keeps remote images out.
     - ACCEPTED by the user's decision, not overlooked: a library request's URL can carry data the page holds into the CDN's logs and, on jsDelivr, into public per-package request statistics; and `show_artifact` publishes without a card in every approval mode, so a prompt-injected agent in `ask` mode could use a page for what its own `curl` would have been asked about.
     - The Electron main process admits these hosts by EXACT name at its resolver and proxy (`ARTIFACT_CDN_HOSTS` in `apps/ui/src/main/network-lockdown.ts`, twinned with the CSP), so every other host stays unresolvable from Chromium. The route sends `Referrer-Policy: no-referrer`, because the page's URL carries its per-artifact key.
     - jsDelivr is admitted at `/npm/` alone, keeping out `/gh/` (any file from any GitHub repository or branch); this does NOT limit who wrote the code, since anyone can publish to npm and unpkg serves every package. The Tailwind v3 Play CDN (`cdn.tailwindcss.com`) is deliberately absent: its unlayered preflight would override the page runtime's `@layer` component kit, so pages use the v4 browser build from jsDelivr.
     - A link in a page is not an outbound call of geniro's: the frame has no popups (its sandbox is `allow-scripts` alone), so a link the page posts is relayed to the host, which opens a web or mail link in the user's browser at once, with no confirmation (`apps/ui/src/renderer/chats/artifact-frame.tsx` — the user's decision), and the main process cancels any navigation of the frame that leaves the artifact route (`guardArtifactFrameNavigations`).
  4. **An anonymous read of a public model PRICE catalog**, from one fixed host: the daemon's `ModelPriceCatalog` (`apps/daemon/src/v1/agents/services/model-price-catalog.service.ts`) GETs `https://models.dev/api.json` (`MODEL_PRICE_CATALOG_URL`, a constant, not config) so a turn whose CLI prices nothing on its wire — codex — gets a list-price dollar figure, and claude's delegate calibration needs no hand-maintained price table. No credential, no cookie, no query, nothing about the user or their conversations is sent. It is the daemon's Node `fetch`, not Chromium, so `network-lockdown.ts` is not involved. At most one refresh per ~12h (at boot when the stored copy is older, and on an hourly staleness check), never blocking the boot; the last good reply is kept at `<userData>/model-prices.json` so pricing works offline, and EVERY failure is logged and swallowed with that copy kept. A model the catalog does not list has no price, which reads as "cost not measured" and never as $0. The test environment turns it off (`fetchModelPrices: false`), so no spec reaches the network.
  5. **A CLI vendor's own installer, on the user's press** (`main/cli-install.ts`, the Install button on an agent card in Onboarding and Settings). Each CLI's descriptor (`main/agents/<cli>.ts` → `installer`) names the ONE script its vendor's docs lead with — `https://claude.ai/install.sh`, `https://cursor.com/install`, `https://chatgpt.com/codex/install.sh` — and main runs exactly `curl -fsSL <url> | <shell>`, as the user would in a terminal (the same shape as `updateCli`, which runs a CLI's own updater). No credential, nothing about the user is sent, the URL is a constant rather than config, and it never runs unasked. The scripts write only under `$HOME` (`~/.local/bin`, which detection already searches) and need neither sudo nor node; codex's adds `~/.local/bin` to the shell profile itself — the vendor's behaviour, not geniro's. The vendor script rather than brew or npm, because either is missing on some Macs.

  What stays refused is the thing the rule is actually for: geniro holding a credential of its own, syncing the user's data anywhere, or talking to a machine on someone else's say-so.

  **The LAN gateway is the one INBOUND exception, and it is the user's own machine serving the user's own devices** (`apps/ui/src/main/remote/`, `Settings.remoteAccessEnabled`, on by default). It answers on the local network so a phone on the same Wi-Fi can open this app's own interface and the same live sessions. Nothing leaves the network and there is still no geniro backend and no account; what it amends is "running a server" — geniro runs one, on the LAN, bounded by:
  - **The DAEMON still binds `127.0.0.1` only** — the gateway does not relax the bullet below. Every LAN-facing byte goes through this one directory, which reverse-proxies to loopback, so "where is this app reachable from" has exactly one answer to audit.
  - **Nothing is proxied to the daemon for a device that has not paired.** `RemoteGateway`'s private `pairedDevice(req)` gates `/v1/*`, `/health` AND the `/ws` upgrade, not merely the gateway's own routes — the proxy INJECTS the daemon's credential, so an ungated arm presents the daemon's own authorization on a stranger's behalf. The upgrade additionally checks `Origin`, because a WebSocket handshake is exempt from the same-origin policy and the browser attaches the cookie regardless of which page asked. Both are pinned by tests that go red when the check is removed.
  - **The daemon's token never leaves the machine.** The gateway injects `Authorization` itself and strips whatever the browser sent, and rewrites the token in a `/ws` upgrade URL (which is why `enforceWsHandshakeAuth` also reads the handshake query). The channels that could hand it over are closed at the registry: `getDaemonHandle` is `denyRemotely` (it is nothing BUT the credential) and `getStatus` carries an `allowRemotelyRedacted` policy that blanks the token in the remote answer alone. A browser synthesises its own handle from `location` with an empty token — which is what makes the `/ws` query rewrite the thing that authenticates it.
  - **A new device types a 6-digit code shown on this screen**, bounded per address AND globally — the global ceiling rotates the code when it trips, because a per-address lockout is no bound when picking a new source address is free.
  - **A `Host` header geniro would never hand out is refused** (loopback, private IPv4, link-local/unique-local IPv6, `*.local` are admitted). That stops a page on the open internet pointing its own domain at the LAN address and driving the gateway from the victim's browser, and keeps a globally-routable IPv6 address (macOS hands one out via SLAAC) from turning a LAN feature into a public one. The listener binds IPv4 only for the same reason.

  **A PUBLIC address is the user's own press, and it is a TUNNEL CLIENT rather than anything geniro hosts** (`apps/ui/src/main/remote/tunnel.ts`, Settings → Remote access → *Get an address*). It starts a client the user already has installed — `cloudflared` first, `ngrok` as the fallback — pointed at the loopback side of the gateway above, and shows the address that client prints. Bounded by:
  - **geniro hosts NOTHING and holds no credential.** No geniro backend, no account, no rendezvous host: the tunnel is a third-party client, chosen by the user, authenticated (where at all) by the user's own login, running as a child of this process. geniro contributes a `spawn` and a regex over the client's own stdout.
  - **Nothing below it is relaxed.** The daemon still binds `127.0.0.1`, the gateway is still the only LAN-facing listener, and a request arriving down the tunnel meets the SAME Host guard, pairing gate, `Origin` check and injected credential as one from the Wi-Fi. cloudflared forwards the public hostname verbatim in `Host` and the browser's `Origin` is the public https origin, so both guards were widened for it deliberately — and only as below.
  - **The widening is a `*.suffix` mask that exists only while the tunnel does** (`extraAllowedHosts`, read fresh per request; `wildcardAdmits` in `host-guard.ts`). A mask is forced — every client mints a fresh subdomain per start, and ngrok can reassign one mid-session — and it refuses a bare `*` and a one-label suffix, since a whole TLD is a zone a stranger can register inside and rebind through. Closing the address narrows the guard in the same instant.
  - **It is opened by a PRESS at the Mac, never by geniro and never by a phone.** `startRemoteTunnel`/`stopRemoteTunnel` are `denyRemotely`, so a paired device — including a stolen one — cannot publish its owner's agents; a launch always starts with no tunnel; and switching remote access off closes it.

  What this exception still does NOT license: a relay or rendezvous host of geniro's own, geniro holding a credential for one, a tunnel geniro opens unasked, or reaching the daemon from anywhere but loopback.

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

See **`apps/daemon/AGENTS.md`** for the full walkthrough — the module layout (every `v1/` module, including every agent adapter and `v1/mcp/`, geniro's own MCP endpoint and its tools), the agent-execution substrate, the workflow/call runtime, and the `### Daemon endpoints (loopback)` table. Claude Code and Cursor load it when `apps/daemon` is touched; Codex loads it only when started inside `apps/daemon`, so read it yourself before working there from the root.

Cross-cutting facts restated here:

- Binds **`127.0.0.1` only**. Assembled exactly like Geniro's `apps/api` (`buildBootstrapper(…)` → `addExtension(buildHttpServerExtension(…))` → `init()`); the loopback specifics ride on the extension's `host` / `portFallback` / `onListening` options — bind 127.0.0.1, negotiate a free port if the preferred one is taken, and write the pidfile from `onListening` after a healthy listen (the `http-server`'s own listen still defaults to `0.0.0.0`, preserving Geniro's behavior). Shutdown is Nest-owned (`enableShutdownHooks`); `utils/pidfile.lifecycle.ts` clears the pidfile on the way out, so `main.ts` needs no signal handling.
- Writes the pidfile (`daemon.json`: `pid`, `host`, `port`, per-launch `token`, `version`, `entry` and `startedAt`) **only after** the schema is synced and the server is listening, then prints `GENIRO_DAEMON_READY {port}` to stdout. The UI never assumes the host/port — it reads the bound values back from the pidfile and does not pass `GENIRO_PORT`; the daemon owns that default.
- Config env (set by the UI): `GENIRO_USER_DATA` (userData dir; fallback `~/.geniro`), `GENIRO_PORT` (preferred port; default `47615` per `DAEMON_PREFERRED_PORT` in `utils/handshake.ts`, falling back to a free port if taken) and `GENIRO_IDLE_EXIT_MS` (self-shutdown window; absent = never, the default for every launch the supervisor did not spawn). DB is `geniro.db`, pidfile `daemon.json`, instance lock `daemon.lock`, child journal `children.json`, one-shot migration marker `workflow-titles-backfilled`, all in the userData dir.

The public allowlist is **`/health` and `/v1/artifacts`** (`PUBLIC_PREFIXES` in `auth/token.guard.ts`), matched at segment boundaries so a sibling route like `/health-debug` doesn't inherit it. The artifact page is gated where the guard cannot reach: it loads as an `<iframe src>`, which cannot carry a bearer header, so the credential rides the URL as a per-ARTIFACT key the store minted (256 bits) — never the launch token, the master key of the whole daemon, in a URL handed to a page an agent wrote. `ArtifactStoreService.read` takes that key as a required argument and compares it in constant time, so no path reads a document without presenting one; it is checked there rather than in the guard because the keys live on disk beside the pages and outlive a restart. `/metrics` and `/swagger-api` are **token-gated**: with a deterministic default port, any web page could otherwise read the daemon's Prometheus internals and full API schema cross-origin. Every non-allowlisted route requires the `Bearer <token>` header — the launch token, or, **only** on `/v1/mcp/<runId>/<nodeId>` and its per-conversation `/v1/mcp/<runId>/<nodeId>/<conversationId>`, that node's own per-node call token (minted when the node first needs the endpoint — for a chat its first turn, since every chat is handed the endpoint for the render tools (`report_findings`, `show_chart`, `show_metrics`, `show_comparison`, `show_gallery`, `show_artifact`, `propose_patch`, `propose_plan`) — revoked at run teardown, keyed by `(runId, nodeId)` so one callee child can't open another node's route). The WS channel is a NestJS Socket.IO gateway (`@WebSocketGateway({ path: '/ws' })`) installed via the `IoAdapter` in `main.ts`; the renderer (`socket.io-client`) sends the per-launch token in the Socket.IO handshake `auth` payload (browsers can't set headers on a WS handshake). The Socket.IO HANDSHAKE never reaches Nest routing (engine.io intercepts `/ws` first), so each gateway owns its own WS auth; the global `LoopbackTokenGuard` runs on gateway MESSAGE handlers and lets `ws` contexts through for exactly that reason (any other non-HTTP transport is refused). Every gateway authenticates through the one shared `auth/ws-auth.ts` → `enforceWsHandshakeAuth` (constant-time `safeEqual`, disconnects on mismatch), called from `handleConnection` in the notifications gateway — never a divergent copy of the check.

### The UI (`apps/ui`)

See **`apps/ui/AGENTS.md`** for the full walkthrough — main process, renderer shell, design system, chats, workflows, settings, macOS packaging, system notifications, sidebar groups, and the `DaemonSupervisor` entry-stamp logic. Claude Code and Cursor load it when `apps/ui` is touched; Codex loads it only when started inside `apps/ui`, so read it yourself before working there from the root.

### Agent instructions — the host preamble and the user's own

**Every turn carries an instruction block, composed at ONE seam.** `AgentAdapter.composeSystemPrompt` (`adapters/agent-adapter.ts`) joins, general → specific: geniro's own **host preamble**, the user's **custom instructions**, a board card's **task instructions** (`taskInstructions` — its label instructions then the report ask, stored on `Run.taskInstructions` apart from the user's text so the forget button cannot purge them), the **instruction blocks** wired to this graph node (`instructionBlocks` — a workflow's `instruction` nodes, joined by the executor in node-list order), the turn's own role (a graph node's `role`), then the caller's "May call" block. A block sits below the user's standing preference and above the node's role because one block is written once for several agents while a role belongs to the one node. The text and the ordering live in `v1/agents/utils/agent-instructions.ts` (`GENIRO_UI_PREAMBLE` + `composeTurnInstructions`); adapters never join these fields themselves (`.claude/rules/agent-adapters.md`). Every shipped transport carries the SAME composed block — claude on `--append-system-prompt`, codex as its thread's `developerInstructions` (set on `thread/start` / `thread/resume`, outside the conversation like claude's), ACP inside the prompt text, since `session/new` and `session/prompt` have no system-instruction field. On ACP the block goes AFTER the user's own words, wrapped in a `<host-context>` element that says what it is: a CLI names the conversation from the prompt text, and the block arrives inside the USER's turn, so leading with it, or leaving it unframed, gets the chat named after — and answered as — geniro's preamble. See `AcpTurnDriver.composePrompt` and `HOST_CONTEXT_TAG`. On ACP the composed block is sent once per session, not per turn — see `apps/daemon/AGENTS.md` → *ACP instruction delivery*.

**The preamble exists to CONTRADICT the CLI's own system prompt, not merely to inform.** Claude Code's own system prompt says its text output is displayed as GitHub-flavored markdown in a terminal, and geniro's only channel is additive — so that claim cannot be deleted, only argued with by name. Every claim in the preamble is checked against this app's renderer rather than a vendor doc: GFM renders (`markdown-content.tsx`), a markdown image with a LOCAL path renders (`markdown-image.tsx` → `GET /v1/chats/:runId/image?path=`), and a REMOTE image does NOT — the renderer CSP is `img-src 'self' data:`, so promising one would produce a visibly broken transcript. It never claims the model can emit an image CONTENT BLOCK (the Messages API allows `image` request-side only), and says nothing about response length, a separate product choice nobody has made.

**The user's half is one global blob, snapshotted per run.** It lives in `settings.json` (`Settings.customInstructions`), rides chat create and workflow-run start on the wire under one exported `CustomInstructionsSchema` (no length limit, but refusing C0 control characters — a NUL reaches `spawn` as argv, where node throws SYNCHRONOUSLY, and the snapshot would repeat that throw on every turn of that chat), and is stored on `Run.customInstructions`. Snapshot rather than a live read, so editing the box changes the NEXT chat: `AgentAdapter.sessionKey` hashes the value, so a live read would invalidate the kept CLI process mid-conversation and respawn it, taking the user's MCP servers down between two messages. A graph node's `role` outranks it (specific beats general), so the two are PEER fields rather than one joined string. The snapshot's escape hatch is `POST /v1/chats/forget-custom-instructions` behind an explicit Settings button — without it, text a user retracts keeps being sent by every chat opened beforehand; it is a press rather than a side effect of the edit because it discards the per-run guarantee.

Carve-outs: an `internalProbe` turn — geniro's own capability reads, whose output is parsed and never rendered — is withheld the preamble, since there is no surface to describe and it would be argv paid on every probe. And the preamble is served back to the Settings screen over `GET /v1/capabilities` (`hostPreamble`) rather than restated in the renderer, so no second copy can drift from the text a CLI actually receives.

### The daemon API client (generated — never hand-mirrored)

The renderer does not restate the daemon's HTTP shapes. `pnpm generate:api` reads the daemon's own OpenAPI document and emits a typed client into **`apps/ui/src/renderer/autogenerated/`** (openapi-generator `typescript-fetch`, mirroring the sibling Geniro web app's `generate:api`). That directory is the single source of every daemon wire type in the UI — `RunDto`, `ItemDto`, `Workflow`, `WorkflowNode`, `AgentKind`, `CapabilitiesDto`, … — plus one API class per swagger tag (`ChatsApi`, `AgentsApi`, `WorkflowsApi`, `CapabilitiesApi`, …). It is **committed**; builds and CI never regenerate. It is excluded from eslint and prettier, and must never be edited by hand — run the generator instead.

`renderer/daemon-api.ts` is the only hand-written transport. It owns what a generator cannot know: the loopback base URL (host/port are negotiated per launch and read from the pidfile), the per-launch bearer token, and the request timeout + uniform error shape (`daemon <METHOD> <path> failed (<status>): <detail>`) the UI is written against. `createDaemonApis(handle)` returns every generated API class bound to one launch — the `DaemonApis` interface is the authoritative list.

**Regenerating**: `pnpm generate:api` (root) → `apps/ui/scripts/generate-api.sh`. It resolves the spec from a throwaway daemon booted out of `apps/daemon/dist` on a temp userData dir (needing nothing running and touching none of the user's data), or from `GENIRO_SWAGGER_URL` when explicitly pointed at a live one. It deliberately does NOT read whatever daemon happens to be running: the committed client must describe the daemon in the WORKING TREE, and a running app can be any older build, which yields a client that regenerates clean while missing the change. Run it after changing any daemon route or wire schema, and commit the diff.

**The daemon side of the contract** (`v1/*` modules):
- Wire shapes are **zod schemas** in each module's types file, with the shared ones carrying `.meta({ id })` so they land as NAMED OpenAPI components; the TS types are `z.infer` of those schemas, so a schema and its type cannot drift.
- Responses are declared with **`@ZodResponse({ status, type: SomeDto })`** (nestjs-zod v5) — no `@nestjs/swagger` CLI plugin is used or wanted (swc cannot run it). One decorator type-checks the handler's return value against the schema, serializes the response through it, sets the status code, and publishes the schema to the document.
- Every controller carries `@ApiTags` (the generated class name), `@ApiBearerAuth`, and `@ApiOperation({ operationId })` (the generated method name — descriptive and globally unique; `setupSwagger` throws on duplicates).
- A response DTO's ROOT schema must **not** carry `.meta({ id })`: nestjs-zod would then register the component under the id while an array response still points at the DTO class name. `setupSwagger` fails the boot on the resulting dangling `$ref` rather than letting it degrade a client type to `any`.
- `WorkflowSchema` is deliberately **default-free** so its request and response renderings are identical and collapse to one `Workflow` type; YAML leniency lives in `WorkflowYamlSchema`, which layers the defaults back on for `parseWorkflowYaml` only.
- `McpController` is `@ApiExcludeController()` — a JSON-RPC channel for caller agents, not a REST resource the UI client should see.

### Design system (renderer) — tokens + shared components

The renderer is styled from design tokens only (Tailwind CSS v4, kept in lockstep with the sibling Geniro web app) — never a hardcoded colour — and reusable UI is always a shared component; every new shared component needs a co-located story in the same commit. Hard rules: `.claude/rules/renderer-design-system.md` and `.claude/rules/renderer-components.md`. The theme layout, how a theme is applied, the eslint and `components/catalog-coverage.spec.ts` mechanisms and the Storybook catalog: `apps/ui/AGENTS.md` → *Design system*.

### Build toolchain
- **swc** compiles the daemon and all `packages/*` to **CommonJS** (`dist/`), with decorator metadata (`legacyDecorator` + `decoratorMetadata`) — entities and Nest DI rely on it. All share one root `.swcrc` (each build script references it via `--config-file ../../.swcrc`).
- **electron-vite** builds the UI (`out/`).
- Internal `@packages/*` imports resolve to **TypeScript source** via the root tsconfig path alias (`@packages/* → packages/*/src`), so the packages ship **no `.d.ts`**. Type-checking is a separate `tsc --noEmit` (`pnpm check-types`), independent of the swc build.

### Storage split
- **Graph definitions → YAML.** See *Constraints (local-first & security)* above — never stored in SQLite.
- **Settings → `settings.json`** in the Electron userData dir. **Removing or renaming a key in this schema DESTROYS what it held** — `readSettings` keeps only keys the schema knows and `writeSettings` rewrites the whole file — so migrate or export the data first. An unparseable file is copied aside to `settings.json.corrupt-<timestamp>` and never written over. `archiveRetentionDays` is `null` by default because it arms permanent deletion of archived chats. The full key catalog: `apps/ui/AGENTS.md` → *Settings keys*.
- **MCP toggles and server definitions → the CLI's own config**, written through each CLI's own mechanism — the deliberate exception to "geniro writes only its own files". Every write refuses an unparseable file rather than replacing it, and claude's needs-auth record is the one CLI cache geniro edits. Details: `apps/daemon/AGENTS.md` → *MCP config writes*.
- **Secrets → there are none.** Every CLI authenticates from its own login state (`claude auth login`, `cursor-agent login`, `codex login`). `main/purge-legacy-secret.ts` deletes the legacy `cursor.apiKey` Keychain entry earlier versions wrote, via the macOS `security` CLI — idempotent, failure-swallowing, and carrying a written expiry so a one-release migration does not become permanent. Any future secret follows the Keychain rule in *Constraints*; a `CURSOR_API_KEY` or `OPENAI_API_KEY` the USER exports in their own shell is not geniro's to store and reaches only that CLI's child.
- **SQLite (`geniro.db`) → runtime/history only** — `runs` / `items` / `node_state` rows. `runs` carries `archivedAt`, the chat sidebar's reversible ARCHIVE (the one-way purge is reached from the archive) — its own column rather than the `softDelete` filter's `deletedAt`, because that filter is global and default-on, so an archived row would be invisible even to the read that unarchives it. `usage_events` (the append-only usage ledger the Stats page reads), its sibling `usage_activity` (what the threads did) and `line_baselines` (the commit each repository's lines are measured from) are deliberately EXEMPT from run teardown: a chat delete hard-deletes its `items`, so a lifetime total computed from the transcript would shrink every time a conversation is tidied away. `usage_events` stores no new figures — every one is already in a `turn_complete` payload — with the agent/model/folder dimensions denormalized at write time because the rows carrying them are destroyed with the run. The exception is cursor's POLLED bill, which no transcript row carries: each priced run keeps one ledger row holding it, rewritten in place as the poll moves.
- **Pasted images → files** under `<userData>/attachments/<runId>/` (`AttachmentStoreService`); only the `{id, mediaType}` row rides the message item's payload, keeping blobs out of the DB. claude gets real base64 image **content blocks** in its stream-json stdin (no `Read` tool, no permission gate; `claude-images.utils.ts`). The ACP path sends the same bytes as ACP `image` content blocks in `session/prompt` (`acp/acp-content.ts`), ahead of the text block — but ONLY to an agent that advertised `promptCapabilities.image`. One that did not gets the text alone plus a `notice` naming what was withheld: the protocol requires the check, an unadvertised image block fails the whole turn, and dropping it silently would leave the agent answering about a screenshot it never received.
- **A phone's attached files → files** under `<userData>/chat-uploads/<uuid>/<name>` (`ChatUploadStoreService`, `POST /v1/chats/uploads`). The composer's paperclip writes a picked file's PATH into the message; on the Mac that is the file's own path, and a phone, which has none, uploads the bytes and gets the stored copy's path back. Not under a run, because the landing composer has no run when the file is picked: an upload is collected by the teardown of the run whose USER messages name it (`ItemDao.userMessagePayloads` — a narrow read, never the transcript). An upload whose path was deleted from the draft before sending is collected by nothing.
- **Published artifacts → files** under `<userData>/artifacts/<runId>/<artifactId>/v<N>.html` (`ArtifactStoreService`), beside a `meta.json` holding that artifact's version and its per-artifact serving key. The `show_artifact` row carries only the descriptor — id, version, title, summary and key — so a 512KB page is never replayed with the transcript. EVERY version is kept: a transcript row names the version it announced, so a republish cannot change what an older card opens. Dropped with the run by `RunTeardownService`, as attachments are. A local picture the page names by an absolute path is copied at publish into `images/<sha256>.<ext>` beside the versions, and the served and saved pages inline it as a `data:` URI, so no route serves a picture to the page. Only png, jpeg, webp, gif and avif are admitted, judged by their bytes (`utils/artifact-image-policy.ts`), and only from `/tmp`, the system temp folder and the run's own folder; a refused picture refuses the whole page. The caps refuse rather than truncate, and the 512KB limit covers the HTML alone.
- **Task worktrees → `<userData>/worktrees/<taskId>/`**, named by the registry at `<userData>/worktrees.json` (`apps/ui/src/main/worktree-service.ts`). Every git call this app makes belongs to the ELECTRON MAIN process: main creates the worktree and the branch, and the daemon is only told the path afterwards, recording it on `Task.worktreePath` and running the agent's chat with it as `cwd`. A file rather than memory, because a force-quit or SIGKILL runs no cleanup and a later pass (`reapFinishedWorktrees`, run each time a daemon comes up) is what remains; an unreadable or malformed registry reads as EMPTY, the safe direction since it only authorizes a delete, and removal is bounded to `<userData>/worktrees/` by path rather than by what the file claims. **A worktree lives until its card's work is FINISHED** — the card is Done and no run is working in it (`isWorkFinished` in `v1/tasks/utils/work-finished.ts`, announced as the `work-finished` reason on `task_changed` and answered in bulk by `POST /v1/tasks/finished`) — never merely until its run SETTLES: a task's run is an ordinary chat that the user continues after review, Retry re-sends into, and the CLI opens turns in when a background command reports back, all in that directory. A second press of Run CONTINUES in the task's standing worktree (`prepareWorktree` → `reused`) rather than refusing its uncommitted work, and a start that is then refused leaves a reused one alone. The BRANCH is never removed with the worktree: at collection main commits whatever the agent left uncommitted onto the task's own branch and only then removes the directory, so every TRACKED change survives; what `.gitignore` excludes does not, which is why collection waits for Done. The hooks are RUN rather than skipped (`--no-verify` is refused project-wide), so a repository whose hooks reject a half-finished tree simply keeps its worktree — the same for a machine with no git identity, since one is never invented. A commit that could not be made is never a reason to remove anyway.
- **Persist-then-emit** for streamed-then-replayable data (chat `items` and graph-node items alike): allocate the monotonic `seq`, write the row, **then** publish on the RxJS bus / per-run Socket.IO room. SQLite is the source of truth and a reconnecting client replays via an `afterSeq` cursor, so nothing is emitted before it is durable.
- **Debug log → 0600 JSONL** under `<userData>/logs/`, rotated, newest few kept (`v1/diagnostics/utils/debug-sink.ts`). The user pastes it into bug reports, so **every entry is scrubbed of registered secrets on its way in** (`apps/daemon/src/v1/diagnostics/utils/redact.ts`). Register a secret at its mint site, before it can be logged: the launch token is registered in `main.ts` one statement after it is minted; a credential a CLI inherits from the user's shell (a `CURSOR_API_KEY`, an `OPENAI_API_KEY`) as the adapter registry is built (`AgentAdapterRegistry` → each adapter's `registerEnvIsolation`); the per-node MCP call token in `CallTokenRegistry.issue()`. Registration, not pattern-matching: a "looks like a token" regex both misses real ones and mangles innocent hex. With `agent-stdio` on the file also holds the raw CLI conversation — the user's own source — which is why that channel is off unless switched on.

**Two inspectors, one per process.** The renderer is a browser, so Chrome DevTools works on it unchanged — ⌥⌘I is bound on a menu item the app deliberately HIDES (`main/app-menu.ts`; a hidden item keeps its accelerator), and the debug panel carries a button for it (`GeniroApi.toggleDevTools` → `event.sender.toggleDevTools()`, the SENDER's own WebContents so one window cannot open another's). It covers the DOM, renderer exceptions and every daemon HTTP call and `/ws` frame the renderer makes, so the debug panel has no HTTP channel. It can NEVER cover the daemon or a spawned CLI. For those the daemon is spawned with `--inspect=127.0.0.1:<DAEMON_INSPECT_PORT>` when the `daemonInspect` setting is on (`DaemonSupervisor.spawnDaemon`, argv AHEAD of the entry script — placed after, node hands it to the daemon as its own argument and it silently does nothing), and `chrome://inspect` attaches real DevTools to it (it works under `ELECTRON_RUN_AS_NODE=1 electron`). The port is 9229, the one address `chrome://inspect` discovers with no configuration. It is a SETTING, off by default and restarting the daemon when flipped: an open inspector port is code execution inside the daemon for anything that reaches loopback, not something to hand a packaged install unasked. The daemon's own log lines do NOT appear in its inspector Console (pino and Nest's `ConsoleLogger` write to fd 1 directly) — the log is the debug panel's job, the inspector's is the code.

---

## A note on vendored packages

`packages/{common,http-server,metrics,mikroorm}` are copied from the sibling Geniro repo (`/Users/sergeirazumovskij/Desktop/Projects/Geniro/geniro`) and adapted: Sentry stripped from `common` and the `http-server` exception path; the mikroorm driver swapped Postgres → `@mikro-orm/sqlite`; OIDC auth in `http-server` left dormant. Local additions, each kept upstreamable:

- `http-server`'s `runHttpApp` / `buildHttpServerExtension` gained backward-compatible `host` / `portFallback` / `onListening` options (bind 127.0.0.1, fall back to a free port, learn the bound port); the defaults preserve Geniro's `0.0.0.0` listen.
- Its `setupSwagger` gained an optional `swagger.guard(authorization)`, mounted as middleware ahead of the swagger routes and the Scalar reference (which no Nest guard ever sees); absent, they stay public as upstream.
- Its request log masks credential-bearing query parameters with `redactSecretQueries` (`src/utils/redact-secret-queries.ts`), and that list names the artifact page's `key` — a parameter only this app mints, so a fix that flows back must keep the name.
- `mikroorm`'s `BaseDao` gained `hardDeleteIncludingSoftDeleted` — a purge that reaches rows the `softDelete` filter hides, for the chat DELETE route; a separate method rather than a flag on `hardDelete` so the destructive form can never be reached by passing an option through.
- `mikroorm`'s `TimestampsEntity` declares its three dates with the `DateTimeType` CLASS instead of the `'datetime'` string: under MikroORM 7 on SQLite the string form snapshots an ISO string while comparing against the stored number, so every loaded entity reads as dirty and any flush stamps `updatedAt` to now.

Keep changes minimal and local-first; the goal is to stay close enough to Geniro that fixes can flow between the repos.
