import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  defineConfig,
  EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind } from '../../runs/runs.types';
import { tempDir } from '../__tests__/temp-dir';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import {
  NodeWallWorkService,
  WALL_WORK_VERSION,
} from './node-wall-work.service';

describe('NodeWallWorkService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let items: ItemDao;
  let nodes: NodeStateDao;
  let runs: RunDao;
  let marker: string;
  let ledger: NodeWallWorkService;
  let seq: number;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
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
    vi.restoreAllMocks();
    const em = orm.em.fork() as EntityManager;
    items = new ItemDao(em);
    nodes = new NodeStateDao(em);
    runs = new RunDao(em);
    marker = join(tempDir('wall-work-'), 'marker');
    ledger = new NodeWallWorkService(items, nodes, runs, em, marker);
    seq = 0;
  });

  async function write(
    kind: ItemKind,
    at: number,
    payload: Record<string, unknown> = {},
    { runId = 'run-1', nodeId = 'eng' } = {},
  ): Promise<number> {
    seq += 1;
    await items.create({
      runId,
      seq,
      kind,
      nodeId,
      payload: JSON.stringify(payload),
      createdAt: new Date(at),
    });
    return seq;
  }

  /** One turn of `nodeId`: running at `from`, settled at `to`, CLI-timed if `durationMs`. */
  async function turn(
    from: number,
    to: number,
    {
      runId = 'run-1',
      nodeId = 'eng',
      durationMs,
    }: { runId?: string; nodeId?: string; durationMs?: number } = {},
  ): Promise<number> {
    await write('status', from, { status: 'running' }, { runId, nodeId });
    const end = await write(
      'turn_complete',
      to,
      { usage: durationMs === undefined ? null : { durationMs } },
      { runId, nodeId },
    );
    await write('status', to, { status: 'completed' }, { runId, nodeId });
    return end;
  }

  /** The stored row, read through a fresh fork. */
  async function stored(
    runId = 'run-1',
    nodeId = 'eng',
  ): Promise<NodeState | null> {
    return new NodeStateDao(orm.em.fork()).getByRunNode(runId, nodeId);
  }

  describe('catchUp', () => {
    it('adds a turn its CLI did not time once, and a second catch-up adds nothing', async () => {
      await nodes.createPending('run-1', 'eng');
      const end = await turn(1_000, 9_000);

      await ledger.catchUp('run-1', 'eng');
      await ledger.catchUp('run-1', 'eng');

      expect(await stored()).toMatchObject({
        workedMs: 8_000,
        wallMeasuredThroughSeq: end,
      });
    });

    it('a later turn adds only itself', async () => {
      await nodes.createPending('run-1', 'eng');
      await turn(1_000, 9_000);
      await ledger.catchUp('run-1', 'eng');
      const end = await turn(20_000, 23_000);

      await ledger.catchUp('run-1', 'eng');

      expect(await stored()).toMatchObject({
        workedMs: 11_000,
        wallMeasuredThroughSeq: end,
      });
    });

    it('concurrent catch-ups add each turn once', async () => {
      // Without the compare-and-set on the mark, each of these folds the same
      // two turns and adds them: 3 × 12s.
      await nodes.createPending('run-1', 'eng');
      await turn(0, 5_000);
      await turn(10_000, 17_000);

      await Promise.all([
        ledger.catchUp('run-1', 'eng', orm.em.fork()),
        ledger.catchUp('run-1', 'eng', orm.em.fork()),
        ledger.catchUp('run-1', 'eng', orm.em.fork()),
      ]);

      expect((await stored())?.workedMs).toBe(12_000);
    });

    it("leaves a claude-style node's figure exactly as the CLI's turns made it", async () => {
      await nodes.createPending('run-1', 'eng');
      await turn(0, 15_000, { durationMs: 5_000 });
      await nodes.rememberWork('run-1', 'eng', 5_000, 1);

      await ledger.catchUp('run-1', 'eng');

      expect(await stored()).toMatchObject({
        workedMs: 5_000,
        wallMeasuredThroughSeq: null,
      });
    });

    it("never adds another node's turns", async () => {
      await nodes.createPending('run-1', 'eng');
      await turn(0, 30_000, { nodeId: 'qa' });

      await ledger.catchUp('run-1', 'eng');

      expect((await stored())?.workedMs).toBeNull();
    });

    it('subtracts a parked card read through its projection', async () => {
      // The card carries a long plan; the DAO projects it to `id`/`callId`,
      // and the verdict (no `callId`) still closes it on the call's clock.
      await nodes.createPending('run-1', 'eng');
      await write('status', 0, { status: 'running', callId: 'call-1' });
      await write('approval_request', 2_000, {
        id: 'card-1',
        callId: 'call-1',
        input: { plan: 'x'.repeat(5_000) },
      });
      await write('approval_verdict', 6_000, { id: 'card-1', allow: true });
      await write('turn_complete', 10_000, { usage: null, callId: 'call-1' });

      await ledger.catchUp('run-1', 'eng');

      expect((await stored())?.workedMs).toBe(6_000);
    });

    it('moves the mark but writes no figure for a turn that measured nothing', async () => {
      await nodes.createPending('run-1', 'eng');
      const end = await turn(4_000, 4_000);

      await ledger.catchUp('run-1', 'eng');

      expect(await stored()).toMatchObject({
        workedMs: null,
        wallMeasuredThroughSeq: end,
      });
    });

    it('does nothing for a node with no row', async () => {
      await turn(0, 9_000);

      await expect(ledger.catchUp('run-1', 'eng')).resolves.toBeUndefined();
      expect(await stored()).toBeNull();
    });

    it('gives up quietly after losing the compare-and-set every time', async () => {
      await nodes.createPending('run-1', 'eng');
      await turn(0, 9_000);
      const cas = vi.spyOn(nodes, 'addWallWork').mockResolvedValue(false);
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});

      await expect(ledger.catchUp('run-1', 'eng')).resolves.toBeUndefined();

      expect(cas).toHaveBeenCalledTimes(5);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('still contended'),
      );
      expect((await stored())?.workedMs).toBeNull();
    });
  });

  describe('sweepAllQuietly', () => {
    it('fills an older workflow run and retires itself', async () => {
      await runs.create({ id: 'run-1', workflowId: 'dev-team' });
      await nodes.createPending('run-1', 'eng');
      await nodes.createPending('run-1', 'qa');
      await turn(0, 9_000);
      await turn(0, 4_000, { nodeId: 'qa' });

      await ledger.sweepAllQuietly();

      expect((await stored('run-1', 'eng'))?.workedMs).toBe(9_000);
      expect((await stored('run-1', 'qa'))?.workedMs).toBe(4_000);
      expect(readFileSync(marker, 'utf8').split('\n')[0]).toBe(
        String(WALL_WORK_VERSION),
      );
    });

    it('stays retired once the marker names the current version', async () => {
      await runs.create({ id: 'run-1', workflowId: 'dev-team' });
      await nodes.createPending('run-1', 'eng');
      await turn(0, 9_000);
      writeFileSync(marker, `${WALL_WORK_VERSION}\n`);

      await ledger.sweepAllQuietly();

      expect((await stored())?.workedMs).toBeNull();
    });

    it('skips a run that fails, fills the rest, and is not retired', async () => {
      await runs.create({ id: 'run-1', workflowId: 'dev-team' });
      await runs.create({ id: 'run-2', workflowId: 'dev-team' });
      await nodes.createPending('run-1', 'eng');
      await nodes.createPending('run-2', 'eng');
      await turn(0, 9_000);
      await turn(0, 3_000, { runId: 'run-2' });
      const listByRun = nodes.listByRun.bind(nodes);
      vi.spyOn(nodes, 'listByRun').mockImplementation((runId, em) =>
        runId === 'run-1'
          ? Promise.reject(new Error('locked'))
          : listByRun(runId, em),
      );
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await expect(ledger.sweepAllQuietly()).resolves.toBeUndefined();

      expect((await stored('run-2', 'eng'))?.workedMs).toBe(3_000);
      expect((await stored('run-1', 'eng'))?.workedMs).toBeNull();
      expect(existsSync(marker)).toBe(false);
    });

    it('resolves when the runs cannot be listed, and is not retired', async () => {
      vi.spyOn(runs, 'listWorkflowRuns').mockRejectedValue(new Error('locked'));
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await expect(ledger.sweepAllQuietly()).resolves.toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    });

    it('still fills the runs when the marker cannot be written', async () => {
      await runs.create({ id: 'run-1', workflowId: 'dev-team' });
      await nodes.createPending('run-1', 'eng');
      await turn(0, 9_000);
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const unwritable = new NodeWallWorkService(
        items,
        nodes,
        runs,
        orm.em.fork() as EntityManager,
        join(marker, 'no-such-dir', 'marker'),
      );

      await expect(unwritable.sweepAllQuietly()).resolves.toBeUndefined();

      expect((await stored())?.workedMs).toBe(9_000);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not record the wall-work sweep'),
      );
    });
  });
});
