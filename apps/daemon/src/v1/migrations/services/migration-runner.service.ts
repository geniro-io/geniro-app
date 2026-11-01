import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InternalException, NotFoundException } from '@packages/common';
import type { Kysely } from 'kysely';

import { environment } from '../../../environments';
import {
  APP_MIGRATIONS_TABLE,
  type FileMigration,
  MIGRATING_LINE_PREFIX,
  type Migration,
  MIGRATION_ERROR_FILE,
  type MigrationErrorReport,
  type MigrationProgress,
  type MigrationRunnerOptions,
  type MigrationRunResult,
  type MigrationsDatabase,
} from '../migrations.types';
import {
  type MigrationBackups,
  migrationBackups,
} from '../utils/migration-backups';
import { MigrationFailedError } from '../utils/migration-failed-error';
import { MIGRATIONS } from '../utils/migration-registry';

interface FailedStep {
  progress: MigrationProgress;
  kind: Migration['kind'];
  error: unknown;
  backups: MigrationBackups | null;
}

/**
 * Applies the registry's pending migrations once per profile, recorded in
 * `app_migrations`.
 *
 * Called from `main.ts` BEFORE `orm.schema.update`, so a rename runs before the
 * sync could add the new name beside the old one. Every database step of a
 * launch runs in one transaction with its journal row; file steps follow the
 * commit, each journaled as it finishes. A failure stops the launch, rolls back
 * every database step and leaves `migration-error.json` for the desktop app.
 */
@Injectable()
export class MigrationRunnerService {
  private readonly logger = new Logger(MigrationRunnerService.name);
  private readonly migrations: readonly Migration[];
  private readonly userDataDir: string;
  private readonly appVersion: string;
  private readonly writeLine: (line: string) => void;
  private readonly now: () => Date;

  constructor(
    private readonly em: EntityManager,
    /** Test seam only — nothing in the app passes it. */
    @Optional() options?: MigrationRunnerOptions,
  ) {
    this.migrations = options?.migrations ?? MIGRATIONS;
    this.userDataDir = options?.userDataDir ?? environment.userDataDir;
    this.appVersion = options?.appVersion ?? environment.version;
    this.writeLine =
      options?.writeLine ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options?.now ?? (() => new Date());
  }

  async run(): Promise<MigrationRunResult> {
    this.assertUniqueIds();
    const em = this.em.fork();
    await this.ensureJournal(em.getKysely<MigrationsDatabase>());
    const applied = await this.appliedIds(em.getKysely<MigrationsDatabase>());
    const pending = this.migrations.filter((m) => !applied.has(m.id));
    if (pending.length === 0) {
      this.clearErrorReport();
      return { applied: [] };
    }

    const database = pending.filter((m) => m.kind === 'database');
    const files = pending.filter((m): m is FileMigration => m.kind === 'files');
    const of = pending.length;
    let step = 0;

    if (database.length > 0) {
      let current: MigrationProgress = {
        id: database[0]?.id ?? '',
        step: 1,
        of,
      };
      try {
        await em.transactional(async (tx) => {
          for (const migration of database) {
            step += 1;
            current = { id: migration.id, step, of };
            this.heartbeat(current);
            const startedAt = Date.now();
            await migration.up({ db: tx.getKysely<unknown>() });
            await this.record(
              tx.getKysely<MigrationsDatabase>(),
              migration.id,
              startedAt,
            );
          }
        });
      } catch (error) {
        throw this.fail({
          progress: current,
          kind: 'database',
          error,
          backups: null,
        });
      }
    }

    for (const migration of files) {
      step += 1;
      const progress = { id: migration.id, step, of };
      this.heartbeat(progress);
      const backups = migrationBackups(
        this.userDataDir,
        migration.id,
        this.now(),
      );
      const startedAt = Date.now();
      try {
        await migration.up({
          userDataDir: this.userDataDir,
          backup: (path) => backups.backup(path),
        });
        await this.record(
          this.em.fork().getKysely<MigrationsDatabase>(),
          migration.id,
          startedAt,
        );
      } catch (error) {
        throw this.fail({ progress, kind: 'files', error, backups });
      }
    }

    this.clearErrorReport();
    const ids = pending.map((m) => m.id);
    this.logger.log(`applied ${ids.length} migration(s): ${ids.join(', ')}`);
    return { applied: ids };
  }

  /** Runs one applied migration's `down` and forgets it. For `migrate:down` against a stopped profile only. */
  async revert(id: string): Promise<void> {
    const migration = this.migrations.find((m) => m.id === id);
    if (!migration) {
      throw new NotFoundException('MIGRATION_NOT_FOUND', `no migration ${id}`);
    }
    const em = this.em.fork();
    await this.ensureJournal(em.getKysely<MigrationsDatabase>());
    if (!(await this.appliedIds(em.getKysely<MigrationsDatabase>())).has(id)) {
      throw new NotFoundException(
        'MIGRATION_NOT_APPLIED',
        `migration ${id} is not applied to this profile`,
      );
    }
    if (migration.kind === 'database') {
      await em.transactional(async (tx) => {
        await migration.down({ db: tx.getKysely<unknown>() });
        await this.forget(tx.getKysely<MigrationsDatabase>(), id);
      });
      return;
    }
    const backups = migrationBackups(
      this.userDataDir,
      `${id}-down`,
      this.now(),
    );
    await migration.down({
      userDataDir: this.userDataDir,
      backup: (path) => backups.backup(path),
    });
    await this.forget(em.getKysely<MigrationsDatabase>(), id);
  }

  private assertUniqueIds(): void {
    const seen = new Set<string>();
    for (const { id } of this.migrations) {
      if (seen.has(id)) {
        throw new InternalException(
          'DUPLICATE_MIGRATION_ID',
          `migration id ${id} is registered twice`,
        );
      }
      seen.add(id);
    }
  }

  private async ensureJournal(db: Kysely<MigrationsDatabase>): Promise<void> {
    await db.schema
      .createTable(APP_MIGRATIONS_TABLE)
      .ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('applied_at', 'text', (column) => column.notNull())
      .addColumn('duration_ms', 'integer', (column) => column.notNull())
      .addColumn('app_version', 'text', (column) => column.notNull())
      .execute();
  }

  private async appliedIds(
    db: Kysely<MigrationsDatabase>,
  ): Promise<Set<string>> {
    const rows = await db
      .selectFrom(APP_MIGRATIONS_TABLE)
      .select('id')
      .execute();
    return new Set(rows.map((row) => row.id));
  }

  private async record(
    db: Kysely<MigrationsDatabase>,
    id: string,
    startedAt: number,
  ): Promise<void> {
    await db
      .insertInto(APP_MIGRATIONS_TABLE)
      .values({
        id,
        applied_at: this.now().toISOString(),
        duration_ms: Date.now() - startedAt,
        app_version: this.appVersion,
      })
      .execute();
  }

  private async forget(
    db: Kysely<MigrationsDatabase>,
    id: string,
  ): Promise<void> {
    await db.deleteFrom(APP_MIGRATIONS_TABLE).where('id', '=', id).execute();
  }

  private heartbeat(progress: MigrationProgress): void {
    this.writeLine(`${MIGRATING_LINE_PREFIX} ${JSON.stringify(progress)}`);
  }

  private fail({
    progress,
    kind,
    error,
    backups,
  }: FailedStep): MigrationFailedError {
    const report: MigrationErrorReport = {
      ...progress,
      kind,
      message: error instanceof Error ? error.message : String(error),
      backupDir: backups?.dir() ?? null,
      appVersion: this.appVersion,
      at: this.now().toISOString(),
    };
    const path = join(this.userDataDir, MIGRATION_ERROR_FILE);
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
      renameSync(`${path}.tmp`, path);
    } catch (writeError) {
      this.logger.error(
        `could not write ${MIGRATION_ERROR_FILE}: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
      );
    }
    return new MigrationFailedError(report);
  }

  private clearErrorReport(): void {
    rmSync(join(this.userDataDir, MIGRATION_ERROR_FILE), { force: true });
  }
}
