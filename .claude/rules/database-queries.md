---
description: Build daemon database queries with typed query builders, never raw SQL
paths:
  - "apps/daemon/src/**"
---

# Database queries

- Build every new or modified database query with MikroORM's QueryBuilder or its integrated typed Kysely builder (`EntityManager.getKysely()`).
- Do not hand-write SQL statements or SQL fragments, including string arguments to `execute()`, `raw()` fragments, or SQL template tags. Express joins, filters, projections, ordering, pagination, functions and mutations through builder methods.
- Pass dynamic values through builder parameters. Never interpolate user input into table names, column names or query text.
- Inside a transaction, create the builder from that transaction's `EntityManager`; every read and write in the atomic operation must use that same transaction.
- Include the required soft-delete and scope filters explicitly when a builder bypasses MikroORM's entity filters.

## The one exception: the chat full-text index's DDL

`apps/daemon/src/db/chat-text-index.ddl.ts` is the one recorded exception to the rules above: `CREATE VIRTUAL TABLE … USING fts5`, the three `CREATE TRIGGER` statements that keep it in step with `items`, and the `DROP` statements a rebuild runs. Change a statement there only by bumping its version (the file's doc block says how). Neither MikroORM's schema generator nor Kysely's schema builder can express a virtual table, and a trigger body is SQL by definition. The exception is narrow on purpose:

- Every statement there is built from constants alone — nothing is interpolated from a runtime value, a setting or user input.
- It is DDL only. Every query against the index — the MATCH search, the trigger check, the backfill, the neighbour read — is built with the typed Kysely builder like any other.
- A new need for hand-written SQL is not covered by this paragraph: it needs its own reason recorded here, or a typed way to say it.

The FTS tables are also listed in `schemaGenerator.skipTables` (`CHAT_TEXT_TABLES`), because the schema sync introspects every table and cannot map an FTS5 column's missing type — keep the two in step if the table is renamed.
