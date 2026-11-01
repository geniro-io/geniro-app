import type { ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type EntityClass, MetadataStorage } from '@mikro-orm/core';
import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BOOT_TIMEOUT_MS,
  bootDaemon,
  stopDaemon,
} from './__tests__/boot-daemon';
import { CHAT_TEXT_TABLES } from './db/chat-text-index.ddl';
import { MEMORY_TEXT_TABLES } from './db/memory-text-index.ddl';
import type { DaemonInfo } from './utils/handshake';
import {
  APP_MIGRATIONS_TABLES,
  MIGRATING_LINE_PREFIX,
} from './v1/migrations/migrations.types';
import { MigrationRunnerService } from './v1/migrations/services/migration-runner.service';
import {
  WORKFLOW_TO_TEAM_COLUMNS,
  WORKFLOW_TO_TEAM_TABLES,
  workflowToTeamNames,
} from './v1/migrations/utils/m0002-workflow-to-team-names';

/**
 * Boots the real daemon on a profile as the build before the Workflow → Team
 * rename left it: every renamed table and column under its old name, holding
 * data, and the library in `workflows/`. The profile is made by a fresh boot of
 * this build, its rename then undone by the migration's own `down` and its
 * journal rows dropped, so it carries every other table and index exactly as
 * the sync builds them.
 */

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface FixtureDatabase {
  app_migrations: { id: string };
  sqlite_master: { name: string; type: string };
  [table: string]: Record<string, unknown>;
}

const marker = (table: string, column: string): string => `${table}.${column}`;

/**
 * Read and written back by the boot itself: rehydration clears a standing
 * card that does not parse, which a marker never does. Its data surviving the
 * rename is pinned by the migration's own spec.
 */
const CLEARED_AT_BOOT = new Set(['runs.pending_team_proposal']);

let userData: string;
let child: ChildProcess;
let info: DaemonInfo;
let output = (): string => '';
let syncAfterRenameAlone = '';

/** Every daemon entity class, imported the way the daemon's own glob finds them. */
async function entityClasses(): Promise<EntityClass<object>[]> {
  await Promise.all(
    globSync('**/*.entity.ts', { cwd: __dirname }).map(
      (file) => import(join(__dirname, file)) as Promise<unknown>,
    ),
  );
  return Object.values(MetadataStorage.getMetadata()).map(
    (meta) => meta.class as EntityClass<object>,
  );
}

async function openDatabase(
  entities: boolean,
  dbName = join(userData, 'geniro.db'),
): Promise<MikroORM> {
  return MikroORM.init(
    defineConfig({
      dbName,
      namingStrategy: UnderscoreNamingStrategy,
      allowGlobalContext: true,
      discovery: { warnWhenNoEntities: false, checkDuplicateFieldNames: false },
      entities: entities ? await entityClasses() : [],
      schemaGenerator: {
        skipTables: [
          CHAT_TEXT_TABLES,
          MEMORY_TEXT_TABLES,
          APP_MIGRATIONS_TABLES,
        ],
      },
    }),
  );
}

/** One row a NOT NULL column without a default would otherwise refuse, the old column marked. */
async function insertMarkedRow(
  orm: MikroORM,
  table: string,
  oldColumns: readonly string[],
): Promise<void> {
  const columns = await orm.em
    .fork()
    .getConnection()
    .execute<ColumnInfo[]>(`pragma table_info(\`${table}\`)`);
  const row: Record<string, unknown> = {};
  for (const column of columns) {
    if (oldColumns.includes(column.name)) {
      row[column.name] = /int|bool/i.test(column.type)
        ? 1
        : marker(table, column.name);
    } else if (
      column.pk > 0 ||
      (column.notnull && column.dflt_value === null)
    ) {
      row[column.name] = /int|bool|real|num|date/i.test(column.type)
        ? column.pk > 0
          ? 1
          : 0
        : `fixture-${column.name}`;
    }
  }
  await orm.em
    .fork()
    .getKysely<FixtureDatabase>()
    .insertInto(table)
    .values(row)
    .execute();
}

async function makePreRenameProfile(): Promise<void> {
  const fresh = await bootDaemon(userData);
  await stopDaemon(fresh.child);

  const orm = await openDatabase(false);
  try {
    const db = orm.em.fork().getKysely<FixtureDatabase>();
    await workflowToTeamNames.down({ db: db as unknown as Kysely<unknown> });
    await db
      .deleteFrom('app_migrations')
      .where('id', 'in', [
        '0002-workflow-to-team-names',
        '0003-team-library-files',
      ])
      .execute();
    const oldColumns = new Map<string, string[]>();
    for (const [table, from] of WORKFLOW_TO_TEAM_COLUMNS) {
      oldColumns.set(table, [...(oldColumns.get(table) ?? []), from]);
    }
    for (const [table, columns] of oldColumns) {
      await insertMarkedRow(orm, table, columns);
    }
    for (const [from] of WORKFLOW_TO_TEAM_TABLES) {
      await insertMarkedRow(orm, from, []);
    }
  } finally {
    await orm.close(true);
  }

  rmSync(join(userData, 'teams'), { recursive: true, force: true });
  mkdirSync(join(userData, 'workflows', '.backups'), { recursive: true });
  writeFileSync(
    join(userData, 'workflows', 'dev-team.geniro.yaml'),
    'name: Dev Team\nnodes:\n  - id: lead\n    kind: agent\n    agent: claude\n    approval: ask\nedges: []\n',
  );
}

/**
 * The schema sync's SQL once 0002 alone has run on a copy of the pre-rename
 * profile, read before any sync, which would otherwise have applied what it
 * found and left nothing to see.
 */
async function syncSqlAfterRenameAlone(): Promise<string> {
  const preview = mkdtempSync(join(tmpdir(), 'geniro-team-rename-preview-'));
  try {
    const dbName = join(preview, 'geniro.db');
    copyFileSync(join(userData, 'geniro.db'), dbName);
    const plain = await openDatabase(false, dbName);
    try {
      await new MigrationRunnerService(plain.em, {
        migrations: [workflowToTeamNames],
        userDataDir: preview,
        appVersion: 'spec',
        writeLine: () => undefined,
      }).run();
    } finally {
      await plain.close(true);
    }
    const orm = await openDatabase(true, dbName);
    try {
      return await orm.schema.getUpdateSchemaSQL({ safe: true, wrap: false });
    } finally {
      await orm.close(true);
    }
  } finally {
    rmSync(preview, { recursive: true, force: true });
  }
}

beforeAll(
  async () => {
    userData = mkdtempSync(join(tmpdir(), 'geniro-team-rename-boot-'));
    await makePreRenameProfile();
    syncAfterRenameAlone = await syncSqlAfterRenameAlone();
    ({ child, info, output } = await bootDaemon(userData));
  },
  BOOT_TIMEOUT_MS * 2 + 10_000,
);

afterAll(async () => {
  await stopDaemon(child);
  rmSync(userData, { recursive: true, force: true });
});

describe('a profile from before the Workflow → Team rename', () => {
  it('renames the database, then moves the library, as one launch', () => {
    expect(output()).toContain(
      `${MIGRATING_LINE_PREFIX} {"id":"0002-workflow-to-team-names","step":1,"of":2}`,
    );
    expect(output()).toContain(
      `${MIGRATING_LINE_PREFIX} {"id":"0003-team-library-files","step":2,"of":2}`,
    );
  });

  it("keeps every renamed column's data under its new name", async () => {
    const orm = await openDatabase(false);
    try {
      const db = orm.em.fork().getKysely<FixtureDatabase>();
      for (const [table, from, to] of WORKFLOW_TO_TEAM_COLUMNS) {
        if (CLEARED_AT_BOOT.has(`${table}.${to}`)) {
          continue;
        }
        const rows = await db
          .selectFrom(table)
          .select(to)
          .where(to, 'is not', null)
          .execute();
        expect(rows.length, `${table}.${to}`).toBeGreaterThan(0);
        expect(
          rows.some((row) =>
            [marker(table, from), 1].includes(row[to] as string | number),
          ),
          `${table}.${to}`,
        ).toBe(true);
      }
      const tables = (
        await db
          .selectFrom('sqlite_master')
          .select('name')
          .where('type', '=', 'table')
          .execute()
      ).map((row) => row.name);
      for (const [from, to] of WORKFLOW_TO_TEAM_TABLES) {
        expect(tables).not.toContain(from);
        expect(tables).toContain(to);
      }
    } finally {
      await orm.close(true);
    }
  });

  it('leaves the schema sync nothing to do once the rename alone has run', () => {
    expect(syncAfterRenameAlone).toBe('');
  });

  it('serves the library it moved to teams/, keeping the originals', async () => {
    const res = await fetch(`http://${info.host}:${info.port}/v1/teams`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(res.status).toBe(200);
    const teams = (await res.json()) as { slug: string; name: string }[];
    expect(teams.map((team) => [team.slug, team.name])).toEqual([
      ['dev-team', 'Dev Team'],
    ]);
    expect(existsSync(join(userData, 'teams', 'dev-team.team.yaml'))).toBe(
      true,
    );
    expect(
      readFileSync(
        join(userData, 'workflows', '.migrated', 'dev-team.geniro.yaml'),
        'utf8',
      ),
    ).toContain('name: Dev Team');
  });
});
