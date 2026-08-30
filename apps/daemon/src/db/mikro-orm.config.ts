import { join } from 'node:path';

import { defineConfig, UnderscoreNamingStrategy } from '@mikro-orm/sqlite';

import { environment } from '../environments';

const { dbPath } = environment;

/**
 * mikro-orm config, cloned from Geniro's apps/api and adapted to SQLite
 * (better-sqlite3-backed `@mikro-orm/sqlite`) for local-first use — the
 * Postgres connection/SSL/schema keys are dropped in favour of a single
 * `dbName` file path.
 */
export default defineConfig({
  dbName: dbPath,
  entities: [join(__dirname, '..', '**', '*.entity.js')],
  entitiesTs: [join(__dirname, '..', '**', '*.entity.ts')],
  // Spread optional DTO fields into FilterQuery without unwanted IS NULL.
  ignoreUndefinedInQuery: true,
  // NestJS request-scoping handles context isolation.
  allowGlobalContext: true,
  namingStrategy: UnderscoreNamingStrategy,
  discovery: { checkDuplicateFieldNames: false },
  // NO `extensions` and no `seeder` block, unlike the sibling's config, and
  // the omission is load-bearing twice over.
  //
  // `SeedManager` comes from a devDEPENDENCY, and this file is imported by
  // `main.ts` — so registering it here would ship a daemon that cannot boot:
  // `pnpm deploy --prod` strips devDependencies out of the packaged app, and
  // the config would then fail to resolve `@mikro-orm/seeder` before Nest ever
  // starts. `db/seed.ts` registers it instead, being the one entry point that
  // is never packaged.
  //
  // The sibling also carries `Migrator`, which this repo deliberately does not
  // have: the schema is synced additively on launch (`orm.schema.update({ safe:
  // true })`) and the versioned migration workflow stays deferred past v1.
  //
  // mikro-orm v7 discovers entities via dynamic import() and emits file:// URLs;
  // strip the prefix so the swc CJS transform's require() shim accepts the path.
  dynamicImportProvider: async (id: string) => {
    const path = id.startsWith('file://') ? new URL(id).pathname : id;
    return import(path);
  },
});
