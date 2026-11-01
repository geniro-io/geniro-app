import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

import { MIGRATION_BACKUPS_DIR } from '../migrations.types';

/** One migration's backup folder, created on its first copy. */
export interface MigrationBackups {
  backup(path: string): string;
  dir(): string | null;
}

export function migrationBackups(
  userDataDir: string,
  migrationId: string,
  now: Date,
): MigrationBackups {
  const target = join(
    userDataDir,
    MIGRATION_BACKUPS_DIR,
    `${migrationId}-${now.toISOString().replaceAll(':', '-')}`,
  );
  let created = false;
  return {
    backup(path) {
      const inside = relative(userDataDir, path);
      const name =
        inside === '' || inside.startsWith('..') || isAbsolute(inside)
          ? basename(path)
          : inside;
      const copy = join(target, name);
      mkdirSync(join(copy, '..'), { recursive: true });
      copyFileSync(path, copy);
      created = true;
      return copy;
    },
    dir: () => (created ? target : null),
  };
}
