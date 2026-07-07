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
| `utils/`       | Pure helpers with no DI (parsers, buffers, spawn plumbing)               |
| `adapters/`    | CLI agent adapters — see `agent-adapters.md`                             |
| `gateways/`    | Socket.IO gateways                                                       |

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
- Unit tests (`*.spec.ts`) are co-located in the same directory as the file under test and move with it.
- When adding a file to a module, place it in its kind-directory from the start; never park it at the module root "temporarily".
- Only create the directories the module actually needs — no empty placeholder dirs.
- The kind-directory layout mirrors the sibling Geniro repo's `apps/api` module convention (e.g. `v1/threads/`), so structure fixes can flow between the repos; the two-files-at-root constraint is a deliberate local tightening (the sibling also parks `*.listener.ts` / `*.utils.ts` at module roots — don't copy that here).
- Reference layout: `apps/daemon/src/v1/agents/`.
