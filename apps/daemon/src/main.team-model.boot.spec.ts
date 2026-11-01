import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

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
  NODE_TO_MEMBER_COLUMNS,
  teamMemberColumns,
} from './v1/migrations/utils/m0004-team-member-columns';
import { TEAM_SHAPE_FILES_ID } from './v1/migrations/utils/m0005-team-shape-files';
import { DEV_TEAM_GRAPH } from './v1/teams/__tests__/dev-team-graph';

/**
 * Boots the real daemon on a profile as the build before the Team model left
 * it: every member column still named `node_id`, holding data, the items
 * index under the name the sync gave it then, the Dev Team still a node graph
 * in the library, and a run whose kept copy is that graph. The profile is made by a fresh
 * boot of this build, its renames undone by the migration's own `down` and its
 * journal row dropped, so every other table and index is exactly what the sync
 * builds.
 */

const ITEMS_INDEX =
  'items_run_id_kind_parent_tool_use_id_node_id_in_call_seq_deleted_at_index';

const ITEMS_INDEX_COLUMNS = [
  'run_id',
  'kind',
  'parent_tool_use_id',
  'node_id',
  'in_call',
  'seq',
  'deleted_at',
] as const;

const LEGACY_RUN = 'run-before-team-model';

let userData: string;
let child: ChildProcess;
let info: DaemonInfo;
let output = (): string => '';
let syncAfterColumnsAlone = '';

async function makePreTeamModelProfile(): Promise<void> {
  const fresh = await bootDaemon(userData);
  await stopDaemon(fresh.child);

  const orm = await openDatabase(join(userData, 'geniro.db'), false);
  try {
    const db = orm.em.fork().getKysely<FixtureDatabase>();
    await teamMemberColumns.down({ db: db as unknown as Kysely<unknown> });
    const memberIndexes = await db
      .selectFrom('sqlite_master')
      .select('name')
      .where('type', '=', 'index')
      .where('tbl_name', '=', 'items')
      .where('sql', 'like', '%node_id%')
      .execute();
    for (const { name } of memberIndexes) {
      await db.schema.dropIndex(name).execute();
    }
    await db.schema
      .createIndex(ITEMS_INDEX)
      .on('items')
      .columns([...ITEMS_INDEX_COLUMNS])
      .execute();
    await db
      .deleteFrom('app_migrations')
      .where('id', 'in', [teamMemberColumns.id, TEAM_SHAPE_FILES_ID])
      .execute();
    for (const [table, from] of NODE_TO_MEMBER_COLUMNS) {
      await insertMarkedRow(orm, table, [from]);
    }
    await insertMarkedRow(orm, 'runs', []);
    await db
      .updateTable('runs')
      .set({
        id: LEGACY_RUN,
        team_id: 'dev-team',
        team_snapshot: JSON.stringify(DEV_TEAM_GRAPH),
        archived_at: null,
        deleted_at: null,
      })
      .execute();
  } finally {
    await orm.close(true);
  }
  mkdirSync(join(userData, 'teams'), { recursive: true });
  writeFileSync(
    join(userData, 'teams', 'dev-team.team.yaml'),
    stringify(DEV_TEAM_GRAPH),
  );
}

const authed = async (path: string): Promise<Response> =>
  fetch(`http://${info.host}:${info.port}${path}`, {
    headers: { authorization: `Bearer ${info.token}` },
  });

beforeAll(
  async () => {
    userData = mkdtempSync(join(tmpdir(), 'geniro-team-model-boot-'));
    await makePreTeamModelProfile();
    syncAfterColumnsAlone = await syncSqlAfter(userData, [teamMemberColumns]);
    ({ child, info, output } = await bootDaemon(userData));
  },
  BOOT_TIMEOUT_MS * 2 + 10_000,
);

afterAll(async () => {
  await stopDaemon(child);
  rmSync(userData, { recursive: true, force: true });
});

describe('a profile from before the Team model', () => {
  it('renames the member columns, then converts the library, as one launch', () => {
    expect(output()).toContain(
      `${MIGRATING_LINE_PREFIX} {"id":"${teamMemberColumns.id}","step":1,"of":2}`,
    );
    expect(output()).toContain(
      `${MIGRATING_LINE_PREFIX} {"id":"${TEAM_SHAPE_FILES_ID}","step":2,"of":2}`,
    );
  });

  it('serves the Dev Team converted: 6 members, the Manager handling the first message', async () => {
    const res = await authed('/v1/teams/dev-team');
    expect(res.status).toBe(200);
    const { team } = (await res.json()) as {
      team: { members: { id: string }[]; triggers: { member: string }[] };
    };
    expect(team.members).toHaveLength(6);
    expect(team.triggers).toEqual([
      { kind: 'first-message', member: 'manager' },
    ]);
    const backups = readdirSync(join(userData, 'backups')).filter((name) =>
      name.startsWith(TEAM_SHAPE_FILES_ID),
    );
    expect(backups).toHaveLength(1);
    expect(
      existsSync(
        join(userData, 'backups', backups[0]!, 'teams', 'dev-team.team.yaml'),
      ),
    ).toBe(true);
  });

  it("reads a run's graph-shaped copy through the converter, never refusing it", async () => {
    const res = await authed(`/v1/teams/runs/${LEGACY_RUN}/team`);
    expect(res.status).toBe(200);
    const { team } = (await res.json()) as {
      team: { members: { name: string }[] };
    };
    expect(team.members.map((m) => m.name)).toEqual([
      'Manager',
      'Senior Engineer',
      'Middle Engineer',
      'Researcher',
      'Handyman',
      'QA',
    ]);
  });

  it("keeps every renamed column's data under member_id", async () => {
    const orm = await openDatabase(join(userData, 'geniro.db'), false);
    try {
      const db = orm.em.fork().getKysely<FixtureDatabase>();
      for (const [table, from, to] of NODE_TO_MEMBER_COLUMNS) {
        const rows = await db
          .selectFrom(table)
          .select(to)
          .where(to, '=', marker(table, from))
          .execute();
        expect(rows, `${table}.${to}`).toHaveLength(1);
      }
    } finally {
      await orm.close(true);
    }
  });

  it('keeps the items index under its name, now over member_id', async () => {
    const orm = await openDatabase(join(userData, 'geniro.db'), false);
    try {
      const index = await orm.em
        .fork()
        .getKysely<FixtureDatabase>()
        .selectFrom('sqlite_master')
        .select('sql')
        .where('type', '=', 'index')
        .where('name', '=', ITEMS_INDEX)
        .executeTakeFirstOrThrow();
      expect(index.sql).toMatch(/[`"]member_id[`"]/);
      expect(index.sql).not.toMatch(/[`"]node_id[`"]/);
    } finally {
      await orm.close(true);
    }
  });

  it('leaves the schema sync nothing to do once the renames alone have run', () => {
    expect(syncAfterColumnsAlone).toBe('');
  });
});
