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
