---
description: Directory layout every daemon (NestJS) feature module must follow
globs:
  - "apps/daemon/src/**"
---

# Daemon module structure

A feature module (`apps/daemon/src/v1/<name>/`) is never a flat pile of files.
Only two files live at the module root:

- `<name>.module.ts` — the Nest module definition
- `<name>.types.ts` (or `chat.types.ts`-style wire types) — the module's shared domain/wire types

Everything else goes into a kind-directory:

| Directory      | Contents                                                                 |
| -------------- | ------------------------------------------------------------------------ |
| `controllers/` | HTTP controllers — route + validation only, delegate to services         |
| `services/`    | `@Injectable()` business logic (services, event buses, registries)       |
| `dao/`         | Data access — extend `BaseDao`, inject `EntityManager` from `@mikro-orm/sqlite` |
| `entity/`      | MikroORM entities (extend `TimestampsEntity`, explicit column types)     |
| `dto/`         | Zod HTTP DTOs via `createZodDto()` from `nestjs-zod`                     |
| `utils/`       | Pure helpers with no DI (parsers, buffers, spawn plumbing), plainly kebab-named at a module level (`json-util.ts`, `ndjson-buffer.ts`); the `*.utils.ts` suffix is used in ONE place only — an adapter's own `adapters/<name>/utils/` and `adapters/utils/` |
| `adapters/`    | CLI agent adapters — see `agent-adapters.md`. A CLI's own probe and per-turn lifecycle services live in its adapter directory, not in `services/` (`adapters/claude/claude-probe.service.ts`); so does a protocol several CLIs could speak, in its own agent-agnostic directory (`adapters/acp/`) |
| `gateways/`    | Socket.IO gateways                                                       |
| `__tests__/`   | Test-only helpers shared by more than one spec — fixtures, process doubles, builders. NOT a home for the specs themselves, which stay co-located (see below) |

## `__tests__/` — shared spec helpers, and only those

Specs are co-located: `foo.spec.ts` sits next to `foo.ts` and moves with it.
What does NOT sit next to production code is a helper that exists only to serve
specs — a fixture, a process double, a builder. It has no production caller, so
placing it in `utils/` claims a production role it does not have, and every
reader then has to open it to learn otherwise.

Such a helper lives in a `__tests__/` directory at the level its specs share —
`adapters/__tests__/fake-group-child.ts`, imported by `agent-adapter.spec.ts`
and by both adapters' specs; `v1/agents/__tests__/fake-child.ts` one level up,
because the specs sharing the synchronous child double span `adapters/` AND
`utils/`. A helper only ONE spec uses does not need the directory at all:
declare it in that spec (`claude.adapter.spec.ts`'s `KillableChild`, the one
behavioural variant of the shared double).

**The directory is the exclusion mechanism, which is the whole point.** Test-only
code must not reach `dist/`, and the daemon has two independent build configs
that must agree on what to skip (`package.json`'s swc `--ignore` globs and
`tsconfig.build.json`'s `exclude`). A directory is a boundary every tool already
understands — `**/__tests__/**` in both — whereas a bespoke filename suffix has
to be re-spelled in each config, and the config that misses the spelling ships
the helper into the build silently. If you add a third build config, it excludes
the same directory.

## Thin controllers, fat services — and types in the types file

- **All business logic lives in `services/`.** A controller method does three
  things only: read the route/body input, make ONE call into a service, and
  (when Nest doesn't do it) shape the HTTP response. Anything more — building
  protocol servers, argument validation beyond the DTO layer, wire-envelope
  construction, error mapping, orchestration — belongs in an `@Injectable()`
  service the controller delegates to. Reference: `McpController` (route +
  delegation only) → `McpServerService` (the whole MCP protocol).
- **A controller file contains exactly one `@Controller` class** — no
  module-scope functions, no helper classes, no exported constants, no private
  helper methods carrying logic. A helper a controller "needs" is business
  logic in disguise: move it into the service (or a pure `utils/` helper the
  service imports).
- **Shared types/interfaces/enums live in the module's root types file**
  (`<name>.types.ts`), never declared in a service/controller file. The moment
  a second file imports a type, it moves to the types file; a type used by
  exactly one file may stay private (unexported) there. Reference: the call
  runtime's `CallMode` / `CallEnvelope` / `CalleeTurnOutcome` /
  `RunCallCapability` live in `graphs.types.ts`, not in the broker.

Rules:

- **Cross-module logic is extracted, never mirrored.** When a module needs logic another module already implements, extract it into the owning module (`utils/` for pure helpers, `services/` for DI) and import it across the boundary — never copy-adapt it. `v1/agents` is the shared agent-execution substrate (adapters, event bus, registries, run DAOs, `utils/event-to-item`, `utils/persist-item`); `v1/graphs` and future consumers import from it. Mirroring is how an invariant fix silently misses one copy — the M3 review found the same code duplicated four times before extraction.
- **The daemon↔renderer HTTP contract is GENERATED, never mirrored.** Wire
  shapes live as zod schemas in the owning module's types file and reach the
  renderer through the daemon's OpenAPI document (`pnpm generate:api` →
  `apps/ui/src/renderer/autogenerated/`). Never hand-copy a daemon shape into
  `apps/ui/src/shared/contracts.ts` — that file is Electron-internal
  (IPC/Settings/CLI/`DaemonHandle`) and holds no daemon types. Adding a
  route or changing a shape means: zod schema (+ `.meta({ id })` if it is shared
  or nested) → response DTO via `createZodDto` → `@ZodResponse` +
  `@ApiOperation({ operationId })` + `@ApiTags` on the controller → regenerate.
- **Carve-out — anything OUTSIDE the HTTP contract is a deliberate TWIN PARSER.**
  The "extract, never mirror" rule governs code sharing *within the daemon*,
  where a shared module is reachable. Anything that never passes through a typed
  HTTP response — a CLI tool payload, a WS envelope, an on-disk handshake file —
  has no generated type, and
  there is no shared package spanning the two sides. For those the deliberate
  answer is a **twin parser**: an independent implementation on each side
  carrying a reciprocal `TWIN PARSER:` doc block that cross-references its twin.
  A shape drift fixed on one side MUST be mirrored on the other, and the doc
  block is what makes that obligation discoverable. Reference twins:
  `apps/daemon/src/v1/agents/adapters/claude/utils/claude-question.utils.ts` ↔
  `apps/ui/src/renderer/chats/approval-card.tsx` (the AskUserQuestion
  `{questions:[{question,options:[{label}]}]}` shape, M4);
  `apps/daemon/src/v1/agents/adapters/cursor-acp/utils/cursor-question.utils.ts` ↔
  the SAME renderer file's `readCursorQuestions` (the `cursor/ask_question`
  `{questions:[{id,prompt,options:[{id,label}]}]}` shape) — one file holding
  two twins, one per CLI, because a question card is routed by the tool name
  the daemon put on the request and each name owns its own parser; and
  `apps/daemon/src/v1/agents/chat.types.ts` `AttachmentWireSchema` ↔
  `apps/ui/src/renderer/chats/attachment-payload.ts` (the `{id, mediaType}`
  image rows inside a message item's `z.unknown()` payload — the payload is
  untyped on the wire BY DESIGN, since each item kind carries a different
  shape, so no generated type reaches the renderer); the same payload's
  `parentToolUseId` (which sub-agent produced a row) AND the `subagent_info`
  row's own `{id,label,kind,prompt,model,durationMs,stepsUnavailableReason}`
  (what a delegate IS, for a CLI that announces one apart from the launching
  call — note the two keys are deliberately different, since one means "the
  delegate produced this row" and the other "this row is about the delegate"):
  `apps/daemon/src/v1/agents/utils/event-to-item.ts` ↔
  `apps/ui/src/renderer/chats/subagent-payload.ts`; and the pidfile's `entry`
  stamp: `apps/daemon/src/utils/handshake.ts` `stampEntry` ↔
  `apps/ui/src/main/daemon-pidfile.ts` `stampEntry` — the one twin that is NOT
  daemon↔renderer but daemon↔Electron-main, where the two apps share no code at
  all (importing daemon source would pull the Nest graph into the main bundle),
  so the file on disk is the entire contract.
- Unit tests (`*.spec.ts`) are co-located in the same directory as the file under test and move with it.
- When adding a file to a module, place it in its kind-directory from the start; never park it at the module root "temporarily".
- Only create the directories the module actually needs — no empty placeholder dirs.
- The kind-directory layout mirrors the sibling Geniro repo's `apps/api` module convention (e.g. `v1/threads/`), so structure fixes can flow between the repos; the two-files-at-root constraint is a deliberate local tightening (the sibling also parks `*.listener.ts` / `*.utils.ts` at module ROOTS — don't copy that: a helper never sits at a module root. The `*.utils.ts` suffix itself is used deliberately inside `adapters/<name>/utils/` and `adapters/utils/`, and nowhere else.)
- Reference layout: `apps/daemon/src/v1/agents/`.
