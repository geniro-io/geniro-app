import { join } from 'node:path';

import { SeedManager } from '@mikro-orm/seeder';
import { MikroORM } from '@mikro-orm/sqlite';

import config from './mikro-orm.config';
import { DatabaseSeeder } from './seeders/database.seeder';

/**
 * Run the seeders — an ENTRY POINT of its own, launched the way `main.ts` is.
 *
 * The sibling repo uses `mikro-orm seeder:run` and this deliberately does not,
 * for a reason that belongs to this app rather than to taste: that CLI runs
 * under host Node, and this daemon's `better-sqlite3` is built against
 * ELECTRON's ABI (`pnpm rebuild:native`, because the shell spawns the daemon
 * with `ELECTRON_RUN_AS_NODE`). A CLI-driven seed therefore cannot open the
 * database at all on a correctly set up machine — it fails on the native
 * module before it reaches a seeder. Sharing an entry point's launch shape with
 * `dev` and `test:unit` is what keeps that from being a per-command surprise.
 *
 * It also does the two things a seeder cannot do for itself: SYNC THE SCHEMA
 * first, so a throwaway directory with no database is a valid target rather
 * than an error, and print where the rows went — the whole hazard here is
 * writing to a profile nobody meant, so the destination is stated out loud on
 * the way out as well as guarded on the way in.
 */
async function seed(): Promise<void> {
  const orm = await MikroORM.init({
    ...config,
    // Registered HERE and not in the shared config, because `@mikro-orm/seeder`
    // is a devDependency and that config is what `main.ts` imports — a
    // packaged daemon has no such package to resolve. See the note in
    // `mikro-orm.config.ts`.
    extensions: [SeedManager],
    seeder: {
      path: join(__dirname, 'seeders'),
      pathTs: join(__dirname, 'seeders'),
      defaultSeeder: 'DatabaseSeeder',
      // Named the way this daemon names files — kebab-case with a kind suffix
      // — rather than the CLI's `FooSeeder.ts` default, so `seeder:create`
      // cannot be the one command that produces an outlier.
      fileName: (className: string) =>
        `${className
          .replace(/Seeder$/, '')
          .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
          .toLowerCase()}.seeder`,
    },
  });
  try {
    // A fresh userData has no tables. The daemon does this at every launch for
    // the same reason (`main.ts`), and additively — nothing here is
    // destructive, so seeding twice adds rows rather than replacing them.
    await orm.schema.update({ safe: true });
    await orm.seeder.seed(DatabaseSeeder);

    console.log(`seeded ${orm.config.get('dbName')}`);
  } finally {
    await orm.close(true);
  }
}

seed().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
