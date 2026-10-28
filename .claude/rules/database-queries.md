---
description: Build daemon database queries with typed query builders, never raw SQL
paths:
  - "apps/daemon/src/**"
---

# Database queries

Every daemon query goes through MikroORM's QueryBuilder or its typed Kysely builder (`EntityManager.getKysely()`).

- Never hand-write SQL or SQL fragments: no SQL strings to `execute()`, no `raw()`, no SQL template tags. Express joins, filters, ordering, pagination, functions and mutations through builder methods.
- Pass dynamic values as builder parameters; never interpolate input into table names, column names or query text.
- Inside a transaction, build every read and write from that transaction's `EntityManager`.
- When a builder bypasses MikroORM's entity filters, add the soft-delete and scope filters explicitly.
- Read a row other code writes through a fork (`this.em.fork()`) or the caller's `EntityManager`, never the DAO's default. With `allowGlobalContext: true` that default is the global `EntityManager`, whose identity map keeps the first copy it loaded, so a later read returns stale fields — `BaseDao.getById(id)` without an `em` included.

## The two exceptions: the full-text indexes' DDL

- `db/chat-text-index.ddl.ts` (`chat_text`, FTS5 over `message`/`reasoning` items, triggers on `items`, repaired at boot by `ChatTextIndexService.ensure()`) and `db/memory-text-index.ddl.ts` (`memories_fts`, FTS5 over each shared-memory entry's title and body, triggers on `memories`, repaired at boot by `MemoryTextIndexService.ensure()`).
- Their DDL (the FTS5 virtual table, its three triggers, and the rebuild's `DROP`s) is hand-written because no builder can express it. Each index sits outside the schema sync; its triggers keep it current.
- Every statement there is built from constants only, and it is DDL only — every query against either index uses the Kysely builder.
- Change a statement only by bumping that file's version (see its doc block).
- The FTS tables are listed in `schemaGenerator.skipTables` (`CHAT_TEXT_TABLES`, `MEMORY_TEXT_TABLES`); keep each in step with its table on a rename.
- Any other need for raw SQL needs its own reason recorded here, or a typed way to say it.
