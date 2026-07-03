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

Rules:

- Unit tests (`*.spec.ts`) are co-located in the same directory as the file under test and move with it.
- When adding a file to a module, place it in its kind-directory from the start; never park it at the module root "temporarily".
- Only create the directories the module actually needs — no empty placeholder dirs.
- The kind-directory layout mirrors the sibling Geniro repo's `apps/api` module convention (e.g. `v1/threads/`), so structure fixes can flow between the repos; the two-files-at-root constraint is a deliberate local tightening (the sibling also parks `*.listener.ts` / `*.utils.ts` at module roots — don't copy that here).
- Reference layout: `apps/daemon/src/v1/agents/`.
