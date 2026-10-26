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

## The one exception: `db/chat-text-index.ddl.ts`

- The chat full-text index's DDL (the FTS5 virtual table, its three triggers on `items`, and the rebuild's `DROP`s) is hand-written because no builder can express it.
- The index (`chat_text`, FTS5 over `message`/`reasoning` items) sits outside the schema sync: the triggers on `items` keep it current, and `ChatTextIndexService.ensure()` builds or repairs it at boot.
- Every statement there is built from constants only, and it is DDL only — every query against the index uses the Kysely builder.
- Change a statement only by bumping its version (see the file's doc block).
- The FTS tables are listed in `schemaGenerator.skipTables` (`CHAT_TEXT_TABLES`); keep the two in step on a rename.
- Any other need for raw SQL needs its own reason recorded here, or a typed way to say it.
