import type { Kysely } from 'kysely';

import {
  APP_MIGRATIONS_TABLE,
  type DatabaseMigration,
  type MigrationsDatabase,
} from '../migrations.types';

/** Reads the journal through the launch's transaction, so the mechanism itself is exercised on every profile once. */
export const appMigrationsJournal: DatabaseMigration = {
  id: '0001-app-migrations-journal',
  kind: 'database',
  async up({ db }) {
    await (db as Kysely<MigrationsDatabase>)
      .selectFrom(APP_MIGRATIONS_TABLE)
      .select('id')
      .limit(1)
      .execute();
  },
  async down() {},
};
