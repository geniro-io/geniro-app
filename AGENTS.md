# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor) working in this repository.

- Guidance lives only in `AGENTS.md` files — this one, `apps/daemon/AGENTS.md`, `apps/ui/AGENTS.md` and `apps/ui/src/main/AGENTS.md` — and the rules under `.claude/rules/`. `.geniro/instructions/` holds the Geniro plugin's own run rules (Claude Code only).
- Each of those directories also has a `CLAUDE.md` that is exactly one line, `@AGENTS.md`. Never write guidance in a `CLAUDE.md`; a guide added in a new directory gets both files.
- Why both: Codex reads only `AGENTS.md` (root down to its start directory); Cursor reads `AGENTS.md` at every level; Claude Code receives a nested guide whole only through the `CLAUDE.md` import.
- Codex cuts the chain at `project_doc_max_bytes`. `.codex/config.toml` raises it to 128 KiB, but Codex reads that file only in a project the user trusted (untrusted: 32 KiB), so keep the rules an agent must not miss near the top of this file.
- Codex reaches the rules and the nested guides as skills: `.agents/skills/rule-<name>/` and `.agents/skills/guide-<dir>/`, generated (see below).

**Contents**: [Issues and pull requests](#issues-and-pull-requests) · [Project Overview](#project-overview) · [CodeGraph](#codegraph--prefer-it-over-grepfind) · [Commands](#commands) · [Coding conventions](#coding-conventions) · [Testing conventions](#testing-conventions) · [Constraints (local-first & security)](#constraints-local-first--security) · [Repository rules](#repository-rules) · [Architecture](#architecture) · [A note on vendored packages](#a-note-on-vendored-packages)

---

## Issues and pull requests

Agents may file issues and open pull requests. The human version is [`CONTRIBUTING.md`](CONTRIBUTING.md).

**Filing an issue**

- Search first (`gh issue list -R geniro-io/geniro-app --state all --search "<words>"`); comment on a match instead of opening a duplicate.
- The forms in `.github/ISSUE_TEMPLATE/` are web-only. From `gh issue create` or the API, write the body with the same `###` headings the form produces, and pass `--label bug` or `--label enhancement`.
- Bug: `### Geniro version`, `### macOS version and chip`, `### Which agent was involved?` (claude / cursor-agent / codex / a team / none), `### Agent CLI version`, `### Steps to reproduce`, `### What happened, and what did you expect?`, `### Debug log`, `### Anything else?`. Write "unknown" rather than guessing a version.
- Feature: `### What problem are you trying to solve?`, `### What would you like to happen?`, `### What do you do today instead?`, `### Would you like to work on it?`. A request that needs a cloud service, telemetry or an account is out of scope (see _Constraints_).
- Never paste a debug log you have not read: it can hold paths and, with `agent-stdio` on, the user's conversation.

**Opening a pull request**

1. Work on a branch, never `main` (its ruleset requires a pull request passing `CI Pass`, but admins can bypass it, so never push to `main` directly anyway). Without push access: `gh repo fork geniro-io/geniro-app --clone`, push to the fork, `gh pr create -R geniro-io/geniro-app`.
2. The PR title is the release: squash-merge PRs so semantic-release reads the title (a merge commit makes it read the branch's own commit messages instead), so use `type(scope): subject` (`fix(ui): …`, `feat(daemon): …`). Commit messages use the same format.
3. Every PR body follows `.github/pull_request_template.md`. `gh pr create --body` replaces the template, so write its headings yourself, in order: `## Why` (with `Closes #N` when there is an issue), `## What changed`, `## How it was verified`, `## Not in this PR` ("nothing" when empty), `## AI assistance` (name the agent), `## Checklist` (tick only what was actually done).
4. Before pushing, `pnpm full-check` passes and any fixes its `lint:fix` made are committed (CI runs `lint` without fixing). A changed daemon route or wire schema also needs `pnpm generate:api` with the regenerated client committed.
5. A change that adds a user-facing feature or changes how one behaves also updates `README.md` in the same PR: the matching section of *What's inside* (or a new one), its wording, and any figure or screenshot it cites. A removed feature leaves the README with it. Internal refactors, fixes that change nothing a user sees, and docs-only changes need no README edit.
6. Every PR adds one changelog fragment, `changelog/unreleased/<short-slug>.md`: what changed, in a user's words, under `### New` (each with a short description under it), `### Improved`, `### Fixed` or `### Internal` (nothing user-visible). Never edit `CHANGELOG.md` or write a version in a feature PR; the release that carries the fragment is read from git at build time. Format and rules: `.claude/rules/changelog.md`.
7. One concern per PR; open it with `--draft` while unfinished.

The issue-heading and PR-heading lists above are twins of the forms and the template: change one, change the other in the same commit.

**Never, in a contribution**

- Commit a credential, token or `.env` file.
- Hand-edit `apps/ui/src/renderer/autogenerated/` (regenerate it).
- Add a cloud service, telemetry or an account.
- Reformat or restructure code the change does not need, especially vendored `packages/*` files.
- Delete a persisted settings key without migrating what it holds (see `.claude/rules/storage-split.md` → Settings).

**Where checks run**: CI is `ubuntu-22.04`, headless, so a Linux sandbox can run all of `pnpm full-check`. `pnpm generate:api` also needs a JVM. Driving the real UI on headless Linux is the `run-desktop` skill (`.claude/skills/run-desktop/`); on a Mac use `pnpm dev`.

---

## Project Overview

geniro-app is a local-first macOS desktop app for composing and running teams of CLI coding agents. Everything runs on the user's machine; there is no cloud.

- An Electron UI (`apps/ui`) supervises a bundled NestJS daemon (`apps/daemon`) that listens on loopback only.
- The daemon is built on packages vendored from the sibling Geniro monorepo, adapted for local use (SQLite, no Sentry/Redis/cloud).
- Agents are driven headlessly through their CLIs only: `claude -p`, `cursor-agent acp` (ACP), and `codex app-server` (its own JSON-RPC). No SDKs, no LangGraph, no Python.
- Every fact about one CLI lives in its own adapter: `v1/agents/adapters/<cli>/` in the daemon, `main/agents/<cli>.ts` in Electron main. The renderer reads per-agent facts from `GET /v1/capabilities` and never spells an agent's name.
- Scope and milestones live in `.geniro/planning/geniro-app-v1/` (local, gitignored).

Stack: TypeScript 6, Node 24.15+, NestJS 12 (Fastify), MikroORM + better-sqlite3, React 19 + Tailwind v4 (electron-vite), pnpm 11 + Turbo, swc, Vitest, ESLint + Prettier.

---

## CodeGraph — prefer it over grep/find

The repo is indexed by CodeGraph (`.codegraph/`, gitignored, always present locally). Use it before grep/find/Read for every code lookup, not just the first.

- MCP tool `codegraph_explore` (load it via tool search if deferred), or shell `codegraph explore "<symbols>"` (`-p <path>` for another checkout). `geniro:*` agents have no MCP tools and no tool search, so they use the shell form.
- Query with symbol names, not prose. Prose matches the commonest symbol names (`error`, `status`) and ranks the wrong files first; output is cut after a few files, so ranking is the answer. For a flow, name the symbols that span it.
- `codegraph.json` `deprioritize` lowers stories, `__tests__/`, the generated client and `packages/` in ranking without hiding them; use `exclude` to hide.
- It cannot answer git provenance (`git show origin/main:<file>`), prevalence counts (`grep -c`) or questions about config files. It beats grep for "what consumes this?", since it follows dynamic dispatch.
- In a worktree, pass `projectPath: <worktree root>` to the MCP tool. The server's default project is fixed at launch, so a bare call answers silently from the launch checkout.
- The MCP tool catches up on its own. The shell form does not: the orchestrator runs `codegraph sync` once before spawning subagents, and a subagent never syncs, because parallel syncs fight over the index lock.
- A worktree without its own `.codegraph/` borrows the main checkout's index (a banner says so); run `codegraph init` there. Never run `init`/`index` just for freshness (full rebuild, ~580 MB).

---

## Commands

Run from the repo root. pnpm only. Run `pnpm install` first.

### Daily development

```bash
pnpm install            # install workspace deps
pnpm rebuild:native     # rebuild better-sqlite3 for Electron's ABI
pnpm dev                # launch the Electron app; it spawns and supervises the daemon
pnpm daemon:dev         # daemon-only watch loop from TS source under Electron-node
pnpm storybook          # component catalog (dev only, never packaged)
```

- Run `pnpm rebuild:native` after every `pnpm install` and after any Electron or Node version change. The daemon runs under Electron's Node (`ELECTRON_RUN_AS_NODE`), so `better-sqlite3` must match Electron's ABI; without it the daemon and `@packages/mikroorm` tests crash.
- Beside an installed Geniro, run `GENIRO_UI_USER_DATA=<dir> pnpm dev`; otherwise dev shares the real profile's single-instance lock and quits silently.
- Never move `pnpm daemon:dev` to `tsx`/esbuild: esbuild emits no decorator metadata, so Nest DI breaks.
- Never add `--watch-kill-signal=SIGKILL`: the default SIGTERM lets Nest shutdown hooks remove the pidfile and reap spawned agents.

### Build, types, lint

```bash
pnpm build              # turbo: swc → dist/ (packages, daemon); electron-vite → out/ (UI)
                        # swc emits CommonJS with decorator metadata (`legacyDecorator` + `decoratorMetadata`) from one root `.swcrc`; entities and Nest DI depend on it
pnpm check-types        # tsc --noEmit per workspace (swc does not type-check)
                        # `@packages/*` resolve to TypeScript source via the root tsconfig paths, so packages ship no `.d.ts`; this is the only type-check
pnpm lint               # eslint, no fixes
pnpm lint:fix           # eslint + prettier auto-fix
```

### Testing

Always use the package scripts, never `vitest` directly.

```bash
pnpm test:unit                                   # all unit tests
pnpm --filter @geniro/daemon test:unit           # one workspace
pnpm --filter @geniro/ui test:unit src/shared/themes.spec.ts   # one spec, path relative to the workspace
pnpm test:cov                                    # coverage, vendored packages only (common, http-server, metrics); the apps define no `test:cov`
```

- `apps/ui/turbo.json` drops `^build` from the UI's `check-types` and test tasks, so a daemon-only edit replays them from turbo's cache. That is sound only while the UI imports no workspace package (`@geniro/daemon`, `@packages/*`), which an eslint `no-restricted-imports` rule enforces, and while every file outside `apps/ui` that a UI spec reads from disk (the daemon sources its twin checks read) is listed in the `inputs` of the UI test tasks there; a change that needs an import restores `^build` there and lifts the rule, and a spec that reads a new daemon file adds it to those `inputs`.

### Seeding a throwaway profile

```bash
GENIRO_USER_DATA="$HOME/Library/Application Support/Geniro-dev" \
  pnpm --filter @geniro/daemon seed
```

Seed rules: `apps/daemon/AGENTS.md`. `GENIRO_SEED_SCENARIOS=waiting-question,working-threads,long-transcript` (or `all`) adds those states to the default fixtures.

### A local stand (macOS)

A worktree's own Electron app and daemon on a scratch profile, beside the installed Geniro. One command per action, from any directory:

```bash
node scripts/stand/boot.mjs <worktree> [--slot k] [--seed <scenarios>] [--fresh]   # prints one JSON line: pids, ports, profile, log
node scripts/stand/cdp.mjs <cdp port> eval|shot|click|text-click|reload|raw|width|tab …
node scripts/stand/stop.mjs <worktree> [--dry-run]                                  # explicit PIDs from the printed list only
```

- Slot k is daemon port 47625+10k and CDP port 9333+10k; `boot.mjs` takes the lowest free one, builds the daemon, waits on `/health/check` and the vite URL, and turns onboarding off. The profile lives under `$TMPDIR/geniro-stands/`, never the real one.
- `stop.mjs` refuses the main checkout and any path that is not a linked worktree, and signals only processes started in the worktree and their children, never its caller, an agent CLI or anything under `/Applications`.

### Before finishing any work

```bash
pnpm full-check         # must pass
```

- It chains `sync:agent-rules --check` → build → check-types → build:tests → lint:fix → test:unit → test:integration. `build:tests`, `test:integration` and `test:e2e*` are placeholders no workspace implements yet.
- CI (`.github/workflows/ci.yaml`) runs `lint`, not `lint:fix`, so commit any fixes `full-check` made. CI also runs `pnpm build-storybook`, the only gate that compiles story files, and runs `rebuild:native` before `test:unit`.
- `turbo.json` sets `agentGuidance: false`. If turbo ever injects a managed block into `AGENTS.md`, delete it by hand.

### Packaging (macOS)

```bash
node scripts/make-signing-identity.mjs   # once: the release signing certificate
pnpm --filter @geniro/ui build:mac       # DMG + zip into release/dist/
```

- `build:mac` signs with the certificate named by `GENIRO_SIGN_IDENTITY`, ad-hoc without it. An ad-hoc build looks like a new app to macOS and loses every privacy grant, so the release workflow fails rather than ship one. Details: `.claude/rules/packaging-config.md` → _macOS packaging_.

### Changelog

```bash
pnpm changelog:check    # parse CHANGELOG.md and every changelog/unreleased/ fragment
pnpm changelog:fold     # move released fragments into CHANGELOG.md (its own PR, never a feature PR)
```

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
- `pnpm up-versions` is maintainer-only: it runs `semantic-release --no-ci` locally and cuts a release tag. Releases run in `.github/workflows/release.yaml`; never run it unasked.

### Database schema

- The daemon syncs the SQLite schema additively at launch (`orm.schema.update({ safe: true })`). A new column or table needs nothing more.
- What the sync cannot express (a rename, a data or YAML rewrite) is a step in the daemon's journaled runner (`apps/daemon/src/v1/migrations/`, `apps/daemon/AGENTS.md` → *Migrations*), run BEFORE the sync and recorded in `app_migrations`. Never MikroORM's Migrator, never a raw-SQL migration.
- A `settings.json` key rename or reshape is a step in `apps/ui/src/main/settings-migrations.ts`, applied to the raw file before `readSettings` (`settingsVersion`).

---

## Coding conventions

- Comments: almost never. Names and code carry the meaning. Never write a comment that restates the code, narrates history ("was", "used to", "reported as"), or quotes a user's request or feedback, in any language. The rare exception is one short line on a constraint the code cannot show.
- No `any`: use specific types, generics, or `unknown` with type guards.
- Throw the custom exceptions from `@packages/common` (`NotFoundException`, `BadRequestException`, …). Never swallow errors silently.
- Import shared packages as `@packages/*`.
- Daemon modules and entities: `.claude/rules/daemon-module-structure.md`.
- CLI agent adapters: `.claude/rules/agent-adapters.md`. geniro's MCP tools: `.claude/rules/mcp-tools.md`.
- "Team" is the thing, in code, wire, storage and copy (`Team`, `TeamsApi`, `TeamStoreService`, the daemon's `v1/teams/`). A team is members (each with a public `role`, private `instructions` and an optional `character`), one first-message trigger naming a member, instruction blocks addressed to an audience, optional stages with responsible members, and a coordination mode; nothing is wired — any member may call any other. New code says "member". "Graph" and "node" survive for teams written before that (the legacy reader, `teamFromWorkflow`), the stage graph, the stored payload keys `nodeId` / `callerNodeId` / `calleeNodeId`, and the run-state code over the `node_state` table (`NodeStateDao`, `NodeStateWire`, the `runs/:runId/nodes` route). "Workflow" stays only where it is someone else's word: Claude Code's own dynamic workflows (`workflow_info`, `workflow-block.tsx`), GitHub Actions, and the readers of rows stored before the rename.
- Renderer UI follows the design system (see _Design system (renderer)_).

---

## Testing conventions

- Vitest, transformed by swc (`vitest.base.ts`); tests run from source.
- `@geniro/daemon`, `@packages/mikroorm` and `@geniro/ui` run their suites under Electron's Node (`ELECTRON_RUN_AS_NODE`), the runtime the code ships on — the UI suite for its Node APIs; run `pnpm rebuild:native` first (_Daily development_).
- Unit tests are co-located `*.spec.{ts,tsx}`. Run them through the package scripts, never `vitest` directly.
- Specs are type-checked: `check-types` uses `tsconfig.json`, which includes specs and `__tests__/`. Never narrow it to the spec-excluding `tsconfig.build.json`.
- React component tests put `// @vitest-environment jsdom` on line 1. Wrap module-scope spies used in a `vi.mock` factory in `vi.hoisted(() => ({ … }))`.
- Never skip on a missing env or service; a missing prerequisite fails loudly.
- No flaky tests: fix nondeterminism at the source, never retry around it. Surface any pre-existing failure you meet and propose a fix.
- No false pins (`.claude/rules/testing.md`).

---

## Constraints (local-first & security)

**No cloud service of geniro's own and no remote code paths.** No geniro backend, telemetry, account or sync. geniro never holds a credential of its own, syncs user data anywhere, or talks to a machine on someone else's say-so. Exactly nine kinds of outbound call are allowed — the user's own login for the user's own data; geniro's own public release metadata and artifacts; an artifact page loading public libraries; the public model price catalog; a CLI vendor's installer on the user's press; an encrypted artifact page sent through the user's own CLI; a gallery picture or a card's media an agent named by URL; the in-app browser; a plugin command the user approved — and the LAN gateway, with its public tunnel, is the one inbound exception. The limits of each are in `.claude/rules/network-constraints.md`; read it before adding or changing anything that reaches the network.

**Other hard rules**

- No Python runtime; the whole stack is TypeScript.
- Secrets live in the macOS Keychain only, never SQLite or a file (accepted exceptions: an agent's own share link, key included, also lands in that agent's transcript — see `.claude/rules/storage-split.md` → `artifact_shares`; and the in-app browser's per-chat cookie jars persist in Chromium's own store in plaintext, as Cursor's and VS Code's browsers do — user decision, see `.claude/rules/storage-split.md` → browser jars). The one kind the app stores is a share key (service `geniro.share`, account = share id), written through `/usr/bin/security -i` on stdin so it never rides argv. The loopback token in `daemon.json` is not a user secret.
- Child env: `buildChildEnv` (`utils/child-env.ts`) strips every `GENIRO_`-prefixed key, the daemon's own `ELECTRON_RUN_AS_NODE` and every adapter's `auth.isolatedEnvKeys`, then each adapter re-injects only its own `auth.inheritedEnvKeys`. Never un-strip a name: an inherited user credential must not reach another CLI's child. It then adds the kill guard last (`utils/child-kill-guard.ts`, `.claude/rules/daemon-run-processes.md` → Kill guard), so every zsh and bash a child starts refuses a `kill` of PID 1, 0, -1 or more than 60 targets.
- Every child process the daemon spawns registers with `ProcessRegistry`, and every detached group is recorded in the child journal; never spawn an unmanaged child. The two resident owners are the exception to the registry, never to the journal: `AgentSessionRegistry` (kept CLI processes) and `EmbeddingProcessService` (the search model's child) own their processes, close them on shutdown and from the pidfile and instance-lock hooks, and stay out of `ProcessRegistry`, whose count would block the idle exit and database compaction (`.claude/rules/daemon-embeddings.md`). The reaper never kills on a pid alone: it re-confirms identity through `utils/process-identity` and leaves an unconfirmable entry alone.
- Run-scoped kills (archive, delete, the sweeps) follow `.claude/rules/daemon-run-processes.md`; never widen them.
- Team definitions are YAML; SQLite holds runtime/history only.
- The daemon binds `127.0.0.1` only and gates every non-public route with the per-launch token.
- No tmux or PTY scraping for graph execution. Inspection is a handoff to the user's own terminal (`v1/handoff/`).
- Never use `--no-verify`.

---

## Repository rules

The rules under `.claude/rules/` are part of this file's contract. Claude Code loads each one by itself when a file under its `paths:` is touched; Cursor and Codex read generated copies (`.cursor/rules/<name>.mdc`, `.agents/skills/rule-<name>/SKILL.md`).

On Codex, and on Cursor when the rule is not already in context, open `.claude/rules/INDEX.md` to find the rule for the path you are about to edit, and follow it.

A new rule gets its row in `.claude/rules/INDEX.md` in the same change, then `pnpm sync:agent-rules`; how a rule is written and generated is in that file.

---

## Architecture

### The daemon (`apps/daemon`)

Full guide: `apps/daemon/AGENTS.md`, with its area rules `.claude/rules/daemon-*.md`. Codex started at the root does not load it (its skill `guide-daemon` points at it); read it yourself before working there. Cross-cutting facts:

- Writes the pidfile (`daemon.json`: pid, host, port, per-launch token, version, entry, startedAt) only after the schema sync and a healthy listen, then prints `GENIRO_DAEMON_READY {port}`. The UI reads host/port from the pidfile and never assumes them.
- Every route needs the per-launch bearer token except the public prefixes `/health` and `/v1/artifacts` (`auth/token.guard.ts`); never put the launch token in a URL. Bind, port, shutdown, env, artifact keys, call tokens and the WebSocket handshake: `apps/daemon/AGENTS.md` → _Daemon endpoints_.

### The UI (`apps/ui`)

Full guides: `apps/ui/AGENTS.md` (renderer shell, design system, settings keys, notifications; the chats, teams and settings pages are `.claude/rules/ui-*.md`) and `apps/ui/src/main/AGENTS.md` (Electron main process: IPC, git and worktrees, daemon supervision, terminal, LAN gateway, app updates, security); macOS packaging: `.claude/rules/packaging-config.md`. Codex started at the root does not load them (skills `guide-ui`, `guide-ui-src-main`); read them yourself before working there.

### Agent instructions — the host preamble and the user's own

- The preamble exists to contradict the CLI's own claim that output goes to a terminal, and to say when each of geniro's own tools is the move. Every claim in it must match this renderer: GFM renders, local-path images render, remote images do not (CSP `img-src 'self' data:`). Never promise remote images or image output blocks, and say nothing about response length.
- Composition, order, per-CLI delivery, and the custom-instruction / reply-language snapshots: `.claude/rules/daemon-agent-instructions.md`. The Settings and team-inspector readouts of it: `.claude/rules/ui-settings.md`.

### The daemon API client (generated — never hand-mirrored)

- `pnpm generate:api` emits a typed client (openapi-generator `typescript-fetch`) into `apps/ui/src/renderer/autogenerated/` from the daemon's OpenAPI document: every wire type (`RunDto`, `ItemDto`, `Team`, …) plus one API class per swagger tag.
- It is committed, excluded from eslint/prettier, and never edited by hand. The renderer never restates a daemon HTTP shape.
- `renderer/daemon-api.ts` is the only hand-written transport: loopback base URL from the pidfile, per-launch bearer token, request timeout, and the error shape `daemon <METHOD> <path> failed (<status>): <detail>`. `createDaemonApis(handle)` binds every API class; the `DaemonApis` interface is the authoritative list.

Daemon side of the contract (zod wire schemas, `@ZodResponse`, operationIds, `setupSwagger` boot checks): `.claude/rules/daemon-module-structure.md`.

### Design system (renderer)

- Rules: `.claude/rules/renderer-design-system.md` and `.claude/rules/renderer-components.md` (both enforced: eslint colour override, `components/catalog-coverage.spec.ts`).
- Themes, theme application and Storybook: `apps/ui/AGENTS.md` → _Design system_.

### Storage split

Where each kind of data lives, and what outlives a run's teardown, in full: `.claude/rules/storage-split.md`.

- **Team definitions → YAML.** Never in SQLite.
- **Plugins → `<userData>/plugins/<slug>.plugin.yaml`**, the approved copy in `.approved/`, backups in `.backups/` (newest 20 per plugin); YAML files, never SQLite or settings.json (`.claude/rules/plugins.md`).
- **Settings → `settings.json`** in the Electron userData dir. The key list is `apps/ui/AGENTS.md` → **Settings keys (`settings.json`).**
- **MCP config → each CLI's own config files**
- **Secrets → the Keychain only.**
- **SQLite (`geniro.db`) → runtime and history only**: `runs`, `items`, `node_state`, and the usage tables.
- **Persist-then-emit** for streamed, replayable data (chat and team-member items): allocate the monotonic `seq`, write the row, then publish.
- **Debug log → 0600 JSONL** under `<userData>/logs/`, rotated. Every entry is scrubbed of registered secrets (`v1/diagnostics/utils/redact.ts`).
- **In-app browser jars → `<userData>/Partitions/geniro-browser-<runId>/`** (Chromium's `persist:` partition, one per chat; user decision: plaintext on disk, like Cursor).
- **Search by meaning → `<userData>/models/<id>-<rev7>/` and `<userData>/embeddings.db`.** The model folder is Electron main's (`main/search-model/`): downloaded when the user turns the feature on, kept when it is turned off, deleted by the user (Settings → Search, Settings → Storage).
- **Pasted images → `<userData>/attachments/<runId>/`.** Only `{id, mediaType}` rides the item payload; never put blobs in the DB.
- **Member pictures → `<userData>/avatars/<sha256>.<ext>`** (`POST /v1/teams/avatars`, png/jpeg/webp/gif judged by bytes, at most 1 MB).
- **Uploaded files (phone) → `<userData>/chat-uploads/<uuid>/<name>`** (`POST /v1/chats/uploads`), collected by the teardown of the run whose user messages name them.
- **Published artifacts → `<userData>/artifacts/<runId>/<artifactId>/v<N>.html`** plus `meta.json` (version, serving key). The `show_artifact` row carries only the descriptor.
- **Configurations geniro made → `<userData>/agent-configs/<cli>/<slug>/`**
- **Task worktrees → `<userData>/worktrees/<taskId>/`**, registry `<userData>/worktrees.json` (`apps/ui/src/main/worktree-service.ts`).
- **What the data folder holds, and its clean-ups → Settings → Storage** (`v1/storage` in the daemon, `app-storage.ts` in main). Every delete is a press with a confirm; chats go only through the archive sweep's teardown.
- **Daemon inspector**: the `daemonInspect` setting (off by default) spawns the daemon with `--inspect=127.0.0.1:9229`. The flag goes before the entry script, or node passes it to the daemon as an argument.

---

## A note on vendored packages

`packages/{common,http-server,metrics,mikroorm}` are copied from the sibling Geniro monorepo; keep changes minimal so fixes flow between the repos. The deliberate local changes: `.claude/rules/vendored-packages.md`.
