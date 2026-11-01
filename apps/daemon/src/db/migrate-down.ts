import { join } from 'node:path';

import { MikroORM } from '@mikro-orm/sqlite';

import { environment } from '../environments';
import {
  acquireInstanceLock,
  DAEMON_LOCK_FILE_NAME,
  DaemonAlreadyRunningError,
} from '../utils/instance-lock';
import { MigrationRunnerService } from '../v1/migrations/services/migration-runner.service';
import config from './mikro-orm.config';

/**
 * `pnpm --filter @geniro/daemon migrate:down <id>`: runs one applied
 * migration's `down` against the profile in `GENIRO_USER_DATA` and removes it
 * from the journal.
 *
 * Launched like `seed.ts`, under Electron's Node, because `better-sqlite3` is
 * built for Electron's ABI. It holds the daemon's own instance lock for its
 * whole length, so it refuses a profile a daemon is running on, and no daemon
 * can start under it.
 */
async function migrateDown(id: string | undefined): Promise<void> {
  if (!id) {
    throw new Error('usage: migrate:down <migration-id>');
  }
  const release = await acquireInstanceLock(
    join(environment.userDataDir, DAEMON_LOCK_FILE_NAME),
  );
  try {
    const orm = await MikroORM.init(config);
    try {
      await new MigrationRunnerService(orm.em).revert(id);
      console.log(`reverted ${id} on ${orm.config.get('dbName')}`);
    } finally {
      await orm.close(true);
    }
  } finally {
    release();
  }
}

migrateDown(process.argv[2]).catch((err: unknown) => {
  console.error(
    err instanceof DaemonAlreadyRunningError
      ? `${err.message} — quit Geniro first`
      : err instanceof Error
        ? err.message
        : String(err),
  );
  process.exitCode = 1;
});
