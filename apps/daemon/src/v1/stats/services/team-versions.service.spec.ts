import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { TeamChangeLogDao } from '../../teams/dao/team-change-log.dao';
import { TeamChangeLogEntry } from '../../teams/entity/team-change-log-entry.entity';
import { TeamChangeLogService } from '../../teams/services/team-change-log.service';
import { TeamStoreService } from '../../teams/services/team-store.service';
import type { Team } from '../../teams/teams.types';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  teamVersionOf,
} from '../../teams/utils/team-version';
import { TeamVersionDao } from '../dao/team-version.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { TeamVersion } from '../entity/team-version.entity';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageEvent } from '../entity/usage-event.entity';
import type { UsageEventInput } from '../stats.types';
import { TeamVersionsService } from './team-versions.service';

const graph: Team = {
  name: 'Dev Team',
  nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }],
  edges: [],
};
const VERSION = teamVersionOf(graph);

/** Real DAOs on an in-memory database: what this service adds is which rows it reads. */
describe('TeamVersionsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let activityDao: UsageActivityDao;
  let usageDao: UsageEventDao;
  let versionDao: TeamVersionDao;
  let changeLog: TeamChangeLogService;
  let get: ReturnType<typeof vi.fn>;
  let service: TeamVersionsService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [UsageActivity, UsageEvent, TeamVersion, TeamChangeLogEntry],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    const em = orm.em.fork();
    activityDao = new UsageActivityDao(em);
    usageDao = new UsageEventDao(em);
    versionDao = new TeamVersionDao(em);
    changeLog = new TeamChangeLogService(new TeamChangeLogDao(em));
    get = vi.fn(async () => ({ slug: 'dev-team', team: graph, hash: 'h' }));
    service = new TeamVersionsService(
      em,
      activityDao,
      usageDao,
      versionDao,
      { all: () => new Map() } as unknown as AgentAdapterRegistry,
      { get } as unknown as TeamStoreService,
      changeLog,
    );
  });

  const created = new Date('2026-10-01T10:00:00.000Z');

  async function teamThread(
    runId: string,
    version = VERSION,
    at = created,
  ): Promise<void> {
    await activityDao.stampThreadVersion(runId, at, {
      slug: 'dev-team',
      version,
      inferred: false,
    });
  }

  function turn(runId: string, costUsd: number): UsageEventInput {
    return {
      runId,
      nodeId: 'start',
      seq: 1,
      occurredAt: created,
      agentKind: 'claude',
      model: null,
      cwd: null,
      teamName: 'Dev Team',
      costUsd,
      estimatedCostUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: 1000,
      apiMs: null,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
    };
  }

  it('counts a run whose chat is gone through what the ledger kept', async () => {
    await teamThread('gone');
    await teamThread('kept');
    await usageDao.recordOnce(turn('gone', 3));
    await usageDao.recordOnce(turn('kept', 1));

    const result = await service.read('dev-team');

    expect(result.versions[0]!.figures).toMatchObject({
      runs: 2,
      costUsd: 4,
      avgCostUsd: 2,
    });
    expect(result.currentVersion).toBe(VERSION);
  });

  it('counts every run past the first batch of ids', async () => {
    for (let index = 0; index < 501; index += 1) {
      await teamThread(`run-${index}`);
    }
    await usageDao.recordOnce(turn('run-500', 7));

    const result = await service.read('dev-team');

    expect(result.totals.runs).toBe(501);
    expect(result.totals.costUsd).toBe(7);
  });

  it('diffs a version’s graph against the one recorded before it', async () => {
    const next: Team = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: 'qa', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
    };
    const NEXT = teamVersionOf(next);
    for (const [team, version, at] of [
      [graph, VERSION, created],
      [next, NEXT, new Date('2026-10-02T10:00:00.000Z')],
    ] as const) {
      await versionDao.register(
        'dev-team',
        version,
        canonicalGraphJson(canonicalGraphOf(team)),
        at,
      );
      await teamThread(`run-${version}`, version, at);
    }

    const [newest, oldest] = (await service.read('dev-team')).versions;

    expect(oldest!.changes).toBeNull();
    expect(newest!.changes).toMatchObject({ removed: 0 });
    expect(newest!.changes!.added).toBeGreaterThan(0);
    expect(newest!.changes!.diff).toContain('+  - id: qa');
  });

  it('names no current version when the library file is gone', async () => {
    await teamThread('run-1');
    get.mockRejectedValueOnce(new NotFoundException('TEAM_NOT_FOUND'));

    expect((await service.read('dev-team')).currentVersion).toBeNull();
  });

  describe('restore', () => {
    let dir: string;
    let store: TeamStoreService;
    let restoring: TeamVersionsService;

    const older: Team = {
      name: 'Old name',
      nodes: [
        { id: 'start', kind: 'trigger', trigger: 'manual' },
        { id: 'dev', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
      edges: [{ from: 'start', to: 'dev', kind: 'data' }],
    };
    const newer: Team = {
      name: 'Dev Team',
      description: 'Ships things',
      maxActiveTurns: 2,
      nodes: [
        ...older.nodes,
        { id: 'qa', kind: 'agent', agent: 'codex', approval: 'auto' },
      ],
      edges: [
        { from: 'start', to: 'dev', kind: 'data', label: 'brief' },
        { from: 'dev', to: 'qa', kind: 'call' },
      ],
      layout: {
        start: { x: 0, y: 0 },
        dev: { x: 100, y: 0 },
        qa: { x: 200, y: 0 },
      },
    };
    const OLDER = teamVersionOf(older);

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'geniro-restore-'));
      store = new TeamStoreService({ teamsDir: dir });
      await store.save('dev-team', newer);
      await versionDao.register(
        'dev-team',
        OLDER,
        canonicalGraphJson(canonicalGraphOf(older)),
        created,
      );
      restoring = new TeamVersionsService(
        orm.em.fork(),
        activityDao,
        usageDao,
        versionDao,
        { all: () => new Map() } as unknown as AgentAdapterRegistry,
        store,
        changeLog,
      );
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('writes the version’s graph, keeping the name, description, places and labels, and backs the old file up', async () => {
      const before = await readFile(join(dir, 'dev-team.team.yaml'), 'utf8');
      const { hash } = await store.get('dev-team');

      const restored = await restoring.restore('dev-team', OLDER, hash);

      const { team } = await store.get('dev-team');
      expect(restored.version).toBe(OLDER);
      expect(teamVersionOf(team)).toBe(OLDER);
      expect(team).toMatchObject({
        name: 'Dev Team',
        description: 'Ships things',
        layout: { start: { x: 0, y: 0 }, dev: { x: 100, y: 0 } },
        edges: [{ from: 'start', to: 'dev', kind: 'data', label: 'brief' }],
      });
      expect(team.maxActiveTurns).toBeUndefined();
      expect(team.layout).not.toHaveProperty('qa');
      expect(restored.hash).toBe((await store.get('dev-team')).hash);
      expect(restored.backup).toMatch(/^\.backups\/dev-team\..+\.yaml$/);
      expect(await readFile(join(dir, restored.backup), 'utf8')).toBe(before);
    });

    it('logs the restore with the version it replaced and the one it wrote back', async () => {
      const { hash, team } = await store.get('dev-team');

      const restored = await restoring.restore('dev-team', OLDER, hash);

      expect(await changeLog.entriesOf('dev-team')).toEqual([
        expect.objectContaining({
          source: 'restore',
          fromVersion: teamVersionOf(team),
          toVersion: OLDER,
          summary: `Restored version 1 (${OLDER})`,
          recommendationIds: [],
          chatRunId: null,
          backup: restored.backup,
        }),
      ]);
    });

    it('logs nothing for a restore it refused', async () => {
      await expect(
        restoring.restore('dev-team', OLDER, 'stale-hash'),
      ).rejects.toThrow();

      expect(await changeLog.entriesOf('dev-team')).toEqual([]);
    });

    describe('with stages', () => {
      const olderStages: NonNullable<Team['stages']> = [
        {
          id: 'build',
          title: 'Build',
          doneWhen: 'It compiles',
          next: ['ship'],
        },
        { id: 'ship', title: 'Ship', doneWhen: 'It is released' },
      ];
      const newerStages: NonNullable<Team['stages']> = [
        { id: 'plan', title: 'Plan', doneWhen: 'A plan exists' },
      ];

      it('writes the version’s own stages over the file’s different ones', async () => {
        const stagedOlder = { ...older, stages: olderStages };
        const stagedVersion = teamVersionOf(stagedOlder);
        await versionDao.register(
          'dev-team',
          stagedVersion,
          canonicalGraphJson(canonicalGraphOf(stagedOlder)),
          created,
        );
        await store.save('dev-team', { ...newer, stages: newerStages });
        const { hash } = await store.get('dev-team');

        const restored = await restoring.restore(
          'dev-team',
          stagedVersion,
          hash,
        );

        const { team } = await store.get('dev-team');
        expect(team.stages).toEqual(olderStages);
        expect(restored.version).toBe(stagedVersion);
        expect(
          await readFile(join(dir, 'dev-team.team.yaml'), 'utf8'),
        ).toContain('id: build');
      });

      it('keeps the stages when the file already has the version’s stages', async () => {
        const stagedOlder = { ...older, stages: olderStages };
        const stagedVersion = teamVersionOf(stagedOlder);
        await versionDao.register(
          'dev-team',
          stagedVersion,
          canonicalGraphJson(canonicalGraphOf(stagedOlder)),
          created,
        );
        await store.save('dev-team', { ...newer, stages: olderStages });
        const { hash } = await store.get('dev-team');

        await restoring.restore('dev-team', stagedVersion, hash);

        expect((await store.get('dev-team')).team.stages).toEqual(olderStages);
      });

      it('restores a stage-less version to a team without stages', async () => {
        await store.save('dev-team', { ...newer, stages: newerStages });
        const { hash } = await store.get('dev-team');

        await restoring.restore('dev-team', OLDER, hash);

        const { team } = await store.get('dev-team');
        expect(team.stages).toBeUndefined();
        expect(teamVersionOf(team)).toBe(OLDER);
      });

      it('numbers a stage edit as a version of its own', async () => {
        const staged = { ...newer, stages: newerStages };
        await store.save('dev-team', staged);
        const { hash } = await store.get('dev-team');

        await restoring.restore('dev-team', OLDER, hash);

        expect(
          (await versionDao.graphsOf('dev-team')).map((graph) => graph.version),
        ).toContain(teamVersionOf(staged));
        expect(teamVersionOf(staged)).not.toBe(teamVersionOf(newer));
      });
    });

    it('records the graph it replaces when no run stamped it, so it can be restored back', async () => {
      const { hash } = await store.get('dev-team');

      await restoring.restore('dev-team', OLDER, hash);

      const read = await restoring.read('dev-team');
      expect(read.currentVersion).toBe(OLDER);
      expect(read.versions.map((row) => [row.version, row.ordinal])).toEqual([
        [teamVersionOf(newer), 2],
        [OLDER, 1],
      ]);

      const back = await restoring.restore(
        'dev-team',
        teamVersionOf(newer),
        (await store.get('dev-team')).hash,
      );
      expect(back.version).toBe(teamVersionOf(newer));
      expect((await restoring.read('dev-team')).currentVersion).toBe(
        teamVersionOf(newer),
      );
    });

    it('records nothing new for a replaced graph a run already stamped', async () => {
      await teamThread('ran-newer', teamVersionOf(newer));
      const { hash } = await store.get('dev-team');

      await restoring.restore('dev-team', OLDER, hash);

      expect(
        (await versionDao.graphsOf('dev-team')).map((graph) => graph.version),
      ).toEqual([OLDER]);
    });

    it('shows the library graph before its first run as the current row', async () => {
      const read = await restoring.read('dev-team');

      expect(read.versions[0]).toMatchObject({
        version: teamVersionOf(newer),
        recorded: false,
        ordinal: null,
        figures: { runs: 0 },
      });
      expect(read.currentVersion).toBe(teamVersionOf(newer));
      expect(read.versions[0]!.changes!.diff).toContain('+  - id: qa');
    });

    it('refuses a copy read before the file changed, writing nothing', async () => {
      const { hash } = await store.get('dev-team');
      await store.save('dev-team', { ...newer, description: 'Edited since' });

      await expect(
        restoring.restore('dev-team', OLDER, hash),
      ).rejects.toMatchObject({ errorCode: 'TEAM_CHANGED' });
      expect(teamVersionOf((await store.get('dev-team')).team)).toBe(
        teamVersionOf(newer),
      );
      expect(await readdir(dir)).not.toContain('.backups');
    });

    it('refuses a version whose graph was never recorded', async () => {
      await expect(
        restoring.restore('dev-team', 'ffffffffffffffff', undefined),
      ).rejects.toMatchObject({ errorCode: 'TEAM_VERSION_NOT_FOUND' });
    });

    it('refuses a team that is gone from the library', async () => {
      await store.delete('dev-team');

      await expect(
        restoring.restore('dev-team', OLDER, undefined),
      ).rejects.toMatchObject({ errorCode: 'TEAM_NOT_FOUND' });
    });
  });
});
