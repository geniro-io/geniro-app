---
description: Directory layout every daemon (NestJS) feature module must follow
paths:
  - "apps/daemon/src/**"
---

# Daemon module structure

A feature module (`apps/daemon/src/v1/<name>/`) keeps only `<name>.module.ts` and its types file at its root. Everything else goes in a kind-directory.

## Kind-directories

- `controllers/` — HTTP controllers (route + delegation only).
- `services/` — `@Injectable()` business logic, event buses, registries.
- `dao/` — extends `BaseDao`, injects `EntityManager` from `@mikro-orm/sqlite`.
- `entity/` — MikroORM entities.
- `dto/` — Zod DTOs via `createZodDto()`.
- `utils/` — pure helpers with no DI, plain kebab names (`ndjson-buffer.ts`). The `*.utils.ts` suffix is used only inside `adapters/<name>/utils/` and `adapters/utils/`.
- `adapters/` — CLI adapters (see `agent-adapters.md`); a CLI's own services live in its adapter directory, not `services/`.
- `gateways/` — Socket.IO gateways.
- `tools/` — geniro's MCP tools, `v1/mcp/` only (see `mcp-tools.md`).
- `__tests__/` — test-only helpers (below); never the specs themselves.

Rules:

- Put a new file in its kind-directory from the start; never at the module root, even temporarily. (The sibling Geniro repo parks `*.listener.ts` / `*.utils.ts` at module roots — don't copy that.)
- Create only the directories the module needs.
- A type used by one file may stay unexported in that file; once a second file imports it, it moves to `<name>.types.ts`.
- Reference layout: `apps/daemon/src/v1/agents/`.

## `__tests__/`

- A fixture, process double or builder shared by several specs lives in a `__tests__/` directory at the level those specs share (`adapters/__tests__/fake-group-child.ts`, `v1/agents/__tests__/fake-child.ts`). Never in `utils/`.
- A helper only one spec uses is declared in that spec.
- A vendored data file a spec reads always lives in `__tests__/` (`adapters/acp/__tests__/acp-schema.v1.21.0.json`).
- The directory is what keeps test code out of `dist/`: both the swc `--ignore` globs in `package.json` and `tsconfig.build.json`'s `exclude` skip `**/__tests__/**`. Never use a filename suffix instead; a new build config must exclude the same directory.

## Sharing code

- Cross-module logic is extracted into its owning module and imported, never copied. `v1/agents` is the shared agent-execution substrate (adapters, event bus, registries, run DAOs, `utils/event-to-item`, `utils/persist-item`).
- The daemon↔renderer HTTP contract is generated, never mirrored (see root `AGENTS.md` → *The daemon API client*).
- Anything outside the typed HTTP contract (a CLI tool payload, a WS envelope, an on-disk handshake file) is a deliberate twin parser: an independent implementation on each side, each carrying a `TWIN PARSER:` doc block naming the other. A shape change on one side must be made on the other. Find them with `grep -rn "TWIN PARSER:" apps packages`.
