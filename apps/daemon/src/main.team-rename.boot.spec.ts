import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BOOT_TIMEOUT_MS,
  bootDaemon,
  stopDaemon,
} from './__tests__/boot-daemon';
import {
  type FixtureDatabase,
  insertMarkedRow,
  marker,
  openDatabase,
  syncSqlAfter,
} from './__tests__/profile-database';
import type { DaemonInfo } from './utils/handshake';
import { MIGRATING_LINE_PREFIX } from './v1/migrations/migrations.types';
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

async function makePreRenameProfile(): Promise<void> {
  const fresh = await bootDaemon(userData);
  await stopDaemon(fresh.child);

  const orm = await openDatabase(join(userData, 'geniro.db'), false);
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

beforeAll(
  async () => {
    userData = mkdtempSync(join(tmpdir(), 'geniro-team-rename-boot-'));
    await makePreRenameProfile();
    syncAfterRenameAlone = await syncSqlAfter(userData, [workflowToTeamNames]);
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
    const orm = await openDatabase(join(userData, 'geniro.db'), false);
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
