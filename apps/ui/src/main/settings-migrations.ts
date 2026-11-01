import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * One versioned rewrite of the raw `settings.json` object, applied before
 * `readSettings` validates and salvages it — the only point where a key the
 * schema no longer knows can still be read and carried over.
 *
 * The input may be a file a failed launch left behind, where the user has since
 * written some keys in the new shape: leave a key already in the new shape
 * alone, and never overwrite a target key that is already present.
 */
export interface SettingsMigration {
  /** Strictly increasing from 1; the file's `settingsVersion` after this step. */
  version: number;
  /** `settings-NNNN-kebab-name`; names its backup folder. */
  id: string;
  migrate(raw: Record<string, unknown>): Record<string, unknown>;
}

const LEGACY_TEAM_TARGET = 'wf:';
const TEAM_TARGET = 'team:';

function teamTarget(value: unknown): unknown {
  return typeof value === 'string' && value.startsWith(LEGACY_TEAM_TARGET)
    ? `${TEAM_TARGET}${value.slice(LEGACY_TEAM_TARGET.length)}`
    : value;
}

/** A composer target names a library team `team:<slug>`, no longer `wf:<slug>`. */
const teamTargets: SettingsMigration = {
  version: 1,
  id: 'settings-0001-team-targets',
  migrate(raw) {
    const next = { ...raw };
    if ('lastChatTarget' in raw) {
      next.lastChatTarget = teamTarget(raw.lastChatTarget);
    }
    if (Array.isArray(raw.runConfigs)) {
      next.runConfigs = raw.runConfigs.map((config: unknown) =>
        typeof config === 'object' && config !== null && !Array.isArray(config)
          ? {
              ...config,
              target: teamTarget((config as { target?: unknown }).target),
            }
          : config,
      );
    }
    return next;
  },
};

/** Every settings migration, in order. Append only. */
export const SETTINGS_MIGRATIONS: readonly SettingsMigration[] = [teamTargets];

/** The `settingsVersion` this build writes. */
export const SETTINGS_VERSION = latestVersion(SETTINGS_MIGRATIONS);

/**
 * `<userData>/` folder for copies of files a migration rewrote.
 *
 * TWIN: the daemon's `MIGRATION_BACKUPS_DIR` in
 * `apps/daemon/src/v1/migrations/migrations.types.ts`, which files the folder
 * under Settings → Storage.
 */
export const SETTINGS_BACKUPS_DIR = 'backups';

export interface SettingsMigrationResult {
  from: number;
  to: number;
  /** The copy of the file as it stood before the first step. */
  backup: string;
}

function latestVersion(migrations: readonly SettingsMigration[]): number {
  let version = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= version) {
      throw new Error(
        `settings migration ${migration.id} has version ${migration.version}, not above ${version}`,
      );
    }
    version = migration.version;
  }
  return version;
}

/** A stored `settingsVersion`, or 0 for a file that predates versioning. */
export function storedSettingsVersion(raw: Record<string, unknown>): number {
  const { settingsVersion } = raw;
  return typeof settingsVersion === 'number' &&
    Number.isInteger(settingsVersion) &&
    settingsVersion >= 0
    ? settingsVersion
    : 0;
}

/**
 * `raw` with every step above its stored version applied in memory: what
 * `readSettings` reads while the file still waits for a launch to migrate it,
 * so a later write carries every value over in its new shape. A step that
 * throws leaves the object as the steps before it left it.
 */
export function withPendingMigrations(
  raw: Record<string, unknown>,
  migrations: readonly SettingsMigration[] = SETTINGS_MIGRATIONS,
): Record<string, unknown> {
  const from = storedSettingsVersion(raw);
  let next = raw;
  for (const migration of migrations) {
    if (migration.version <= from) {
      continue;
    }
    try {
      next = migration.migrate(next);
    } catch {
      return next;
    }
  }
  return next;
}

/**
 * Bring `<userData>/settings.json` up to {@link SETTINGS_VERSION}, backing the
 * file up first. Null when there was nothing to do: no file, a file that is not
 * a JSON object (left for `readSettings`, which preserves it), or one already
 * current or newer.
 */
export function migrateSettingsFile(
  userDataDir: string,
  migrations: readonly SettingsMigration[] = SETTINGS_MIGRATIONS,
  now: Date = new Date(),
): SettingsMigrationResult | null {
  const target = latestVersion(migrations);
  const path = join(userDataDir, 'settings.json');
  if (!existsSync(path)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const from = storedSettingsVersion(raw as Record<string, unknown>);
  const pending = migrations.filter((migration) => migration.version > from);
  const first = pending[0];
  if (first === undefined) {
    return null;
  }

  const folder = join(
    userDataDir,
    SETTINGS_BACKUPS_DIR,
    `${first.id}-${now.toISOString().replaceAll(':', '-')}`,
  );
  mkdirSync(folder, { recursive: true });
  const backup = join(folder, 'settings.json');
  copyFileSync(path, backup);

  let next = { ...(raw as Record<string, unknown>) };
  for (const migration of pending) {
    next = migration.migrate(next);
  }
  next.settingsVersion = target;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, path);
  return { from, to: target, backup };
}
