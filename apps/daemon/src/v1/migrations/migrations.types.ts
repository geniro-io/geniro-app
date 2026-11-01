import type { Kysely } from 'kysely';

/** The journal of every migration this profile has applied. Outside the schema sync. */
export const APP_MIGRATIONS_TABLE = 'app_migrations';

/** Keeps the journal invisible to `orm.schema.update`, which owns only entity tables. */
export const APP_MIGRATIONS_TABLES = /^app_migrations$/;

/**
 * Printed on stdout before each step, followed by a JSON {@link MigrationProgress}.
 *
 * TWIN PARSER: `DAEMON_MIGRATING_PREFIX` in `apps/ui/src/main/daemon-pidfile.ts`,
 * which reads each line as a heartbeat that extends the start deadline.
 */
export const MIGRATING_LINE_PREFIX = 'GENIRO_DAEMON_MIGRATING';

/**
 * The daemon's exit code when a migration step failed.
 *
 * TWIN: `DAEMON_MIGRATION_EXIT_CODE` in `apps/ui/src/main/daemon-pidfile.ts`,
 * which stops respawning on it.
 */
export const MIGRATION_FAILED_EXIT_CODE = 78;

/**
 * `<userData>/` file describing the last failed migration; removed by the next launch that migrates cleanly.
 *
 * TWIN PARSER: `DAEMON_MIGRATION_ERROR_NAME` in `apps/ui/src/main/daemon-pidfile.ts`.
 */
export const MIGRATION_ERROR_FILE = 'migration-error.json';

/** `<userData>/` folder holding a copy of every file a migration rewrote. Shared with Electron main's settings migrator. */
export const MIGRATION_BACKUPS_DIR = 'backups';

export interface MigrationsDatabase {
  app_migrations: {
    id: string;
    applied_at: string;
    duration_ms: number;
    app_version: string;
  };
}

export interface MigrationProgress {
  id: string;
  /** 1-based position among this launch's pending migrations. */
  step: number;
  of: number;
}

export interface MigrationErrorReport extends MigrationProgress {
  /** `database`: the launch's transaction was rolled back. `files`: the database steps and earlier file steps stand. */
  kind: Migration['kind'];
  message: string;
  /** Where the failed step's backups went; null when it backed nothing up. */
  backupDir: string | null;
  appVersion: string;
  at: string;
}

/** Bound to the launch's one transaction: every database step commits or rolls back together. */
export interface DatabaseMigrationContext {
  db: Kysely<unknown>;
}

export interface FileMigrationContext {
  userDataDir: string;
  /** Copies `path` under this migration's backup folder; call before rewriting the file. */
  backup(path: string): string;
}

interface MigrationBase<Context> {
  /** `NNNN-kebab-name`, unique, never reused, never renamed once shipped. */
  id: string;
  up(context: Context): Promise<void>;
  down(context: Context): Promise<void>;
}

/**
 * Schema or data changes; metadata-only DDL, since a launch has
 * `START_TIMEOUT_MS` between heartbeats. It also runs on a new profile, before
 * the sync has created any entity table, so a step whose source table or
 * column is missing must do nothing (`db.introspection.getTables()`).
 */
export interface DatabaseMigration extends MigrationBase<DatabaseMigrationContext> {
  kind: 'database';
}

/** Rewrites small files under the data folder; runs after the database commit and must be idempotent. */
export interface FileMigration extends MigrationBase<FileMigrationContext> {
  kind: 'files';
}

export type Migration = DatabaseMigration | FileMigration;

export interface MigrationRunnerOptions {
  migrations?: readonly Migration[];
  userDataDir?: string;
  appVersion?: string;
  writeLine?: (line: string) => void;
  now?: () => Date;
}

export interface MigrationRunResult {
  applied: string[];
}
