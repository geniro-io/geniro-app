import {
  defineConfig,
  EntityManager,
  MikroORM,
  SqlEntityRepository,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
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

import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import {
  readSessionHistory,
  readSpendMarks,
} from '../utils/cursor-spend-marks';
import { NodeStateDao } from './node-state.dao';

/**
 * Real-driver DAO spec (see item.dao.spec for the harness rationale): pins the
 * F39 agent-kind stamp — the terminal mirror resolves a HISTORICAL run's CLI
 * from this column, so it must round-trip and must survive later status
 * transitions that don't carry it.
 */
describe('NodeStateDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: NodeStateDao;

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
    dao = new NodeStateDao(orm.em.fork());
  });

  it('stamps agentKind at the running transition and round-trips it', async () => {
    await dao.createPending('run-1', 'node-a');
    await dao.setStatus('run-1', 'node-a', {
      status: 'running',
      startedAt: 111,
      agentKind: 'cursor-agent',
    });

    const row = await dao.getByRunNode('run-1', 'node-a');
    expect(row?.status).toBe('running');
    expect(row?.agentKind).toBe('cursor-agent');
  });

  it('a later transition WITHOUT agentKind leaves the stamp untouched', async () => {
    await dao.setStatus('run-1', 'node-a', {
      status: 'running',
      agentKind: 'claude',
    });
    await dao.setStatus('run-1', 'node-a', { status: 'completed', endedAt: 5 });

    const row = await dao.getByRunNode('run-1', 'node-a');
    expect(row?.status).toBe('completed');
    expect(row?.agentKind).toBe('claude');
  });

  describe('the model stamp', () => {
    /** Read back through a FRESH fork, so the answer is the stored row. */
    const stored = (nodeId: string): Promise<NodeState | null> =>
      new NodeStateDao(orm.em.fork()).getByRunNode('run-1', nodeId);

    it('stamps the model on a row the transition CREATES', async () => {
      // `setStatus` accepted `model` and wrote it on neither path, so every
      // workflow node read back null — Stats filed all workflow spend under
      // "no model" and a chat export named none.
      await dao.setStatus('run-1', 'node-a', {
        status: 'running',
        agentKind: 'claude',
        model: 'claude-opus-5',
      });

      expect((await stored('node-a'))?.model).toBe('claude-opus-5');
    });

    it('stamps the model on the pending row a workflow start seeded', async () => {
      // The executor's own order: `createPending` at run start, the model at
      // the turn's running transition — the UPDATE path.
      await dao.createPending('run-1', 'node-a');
      await dao.setStatus('run-1', 'node-a', {
        status: 'running',
        agentKind: 'cursor-agent',
        model: 'kimi-k3',
      });

      expect((await stored('node-a'))?.model).toBe('kimi-k3');
    });

    it('a later transition WITHOUT a model leaves the stamp untouched', async () => {
      await dao.setStatus('run-1', 'node-a', {
        status: 'running',
        model: 'claude-opus-5',
      });
      await dao.setStatus('run-1', 'node-a', {
        status: 'completed',
        endedAt: 5,
      });

      expect((await stored('node-a'))?.model).toBe('claude-opus-5');
    });
  });

  it('a row created without a stamp reads null (the legacy YAML-fallback marker)', async () => {
    await dao.createPending('run-1', 'node-a');
    const row = await dao.getByRunNode('run-1', 'node-a');
    expect(row?.agentKind).toBeNull();
  });

  describe('rememberContext', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('issues a single nativeUpdate against {runId, nodeId} and never reads or flushes', async () => {
      await dao.createPending('run-1', 'node-a');

      const nativeUpdateSpy = vi.spyOn(
        SqlEntityRepository.prototype,
        'nativeUpdate',
      );
      const findOneSpy = vi.spyOn(SqlEntityRepository.prototype, 'findOne');
      const flushSpy = vi.spyOn(EntityManager.prototype, 'flush');

      await dao.rememberContext('run-1', 'node-a', 500, 1000);

      expect(nativeUpdateSpy).toHaveBeenCalledTimes(1);
      expect(nativeUpdateSpy).toHaveBeenCalledWith(
        { runId: 'run-1', nodeId: 'node-a' },
        { contextTokens: 500, contextWindowTokens: 1000 },
      );
      expect(findOneSpy).not.toHaveBeenCalled();
      expect(flushSpy).not.toHaveBeenCalled();

      // A fresh fork, not `dao`'s own: `nativeUpdate` writes past the identity
      // map, so re-reading through the same fork that ran `createPending`
      // would assert the cached entity rather than the row (see `retitle`'s
      // spec above for the same caveat on `RunDao`).
      const row = await new NodeStateDao(orm.em.fork()).getByRunNode(
        'run-1',
        'node-a',
      );
      expect(row?.contextTokens).toBe(500);
      expect(row?.contextWindowTokens).toBe(1000);
    });

    it('a runId/nodeId pair with no row writes nothing and does not throw', async () => {
      await expect(
        dao.rememberContext('missing-run', 'missing-node', 500, 1000),
      ).resolves.toBeUndefined();

      const row = await dao.getByRunNode('missing-run', 'missing-node');
      expect(row).toBeNull();
    });

    it('a reading with NOTHING positive in it does not reach the database', async () => {
      await dao.createPending('run-1', 'node-a');
      await dao.rememberContext('run-1', 'node-a', 500, 1000);

      const nativeUpdateSpy = vi.spyOn(
        SqlEntityRepository.prototype,
        'nativeUpdate',
      );
      // Neither half is a measurement — a zero count is what a turn that
      // measured nothing reports, and null is silence. Writing either would
      // erase the reading beside it, which is the whole reason this method
      // builds its patch field by field.
      await dao.rememberContext('run-1', 'node-a', 0, null);

      expect(nativeUpdateSpy).not.toHaveBeenCalled();
      const row = await new NodeStateDao(orm.em.fork()).getByRunNode(
        'run-1',
        'node-a',
      );
      expect(row?.contextTokens).toBe(500);
      expect(row?.contextWindowTokens).toBe(1000);
    });
  });

  describe('saveSessionId', () => {
    // `agentSessionId` is overwritten by every turn, and a node answers each
    // call in a conversation of its own — the history is the only record of
    // the earlier ones, which the cursor spend poll prices from.
    it('keeps every session the node has run in, not only the latest', async () => {
      await dao.saveSessionId('run-1', 'node-a', 'conv-1');
      await dao.saveSessionId('run-1', 'node-a', 'conv-2');
      await dao.saveSessionId('run-1', 'node-a', 'conv-1');

      const row = await new NodeStateDao(orm.em.fork()).getByRunNode(
        'run-1',
        'node-a',
      );
      expect(row?.agentSessionId).toBe('conv-1');
      expect(readSessionHistory(row?.sessionIds ?? null)).toEqual([
        'conv-1',
        'conv-2',
      ]);
    });

    // Two calls to one node run in parallel and each saves its own session;
    // a read-then-write per save let the second drop the first — and that
    // conversation is then never priced, the saver never saving it again.
    it('loses neither session when two saves for one node land together', async () => {
      await dao.createPending('run-1', 'node-a');

      await Promise.all([
        dao.saveSessionId('run-1', 'node-a', 'conv-a'),
        dao.saveSessionId('run-1', 'node-a', 'conv-b'),
        dao.saveSessionId('run-1', 'node-a', 'conv-c'),
      ]);

      const row = await new NodeStateDao(orm.em.fork()).getByRunNode(
        'run-1',
        'node-a',
      );
      expect([...readSessionHistory(row?.sessionIds ?? null)].sort()).toEqual([
        'conv-a',
        'conv-b',
        'conv-c',
      ]);
    });
  });

  describe('rememberCursorSpendThrough', () => {
    const marks = async (): Promise<Map<string, number>> =>
      readSpendMarks(
        (await new NodeStateDao(orm.em.fork()).getByRunNode('run-1', 'node-a'))
          ?.cursorSpendThrough ?? null,
      );

    it('advances the watermark forward', async () => {
      await dao.createPending('run-1', 'node-a');

      await dao.rememberCursorSpendThrough('run-1', 'node-a', 'conv-1', 2000);

      expect((await marks()).get('conv-1')).toBe(2000);
    });

    it('REFUSES to move a watermark backwards', async () => {
      // The whole double-count defence for the cursor spend accumulator: a mark
      // that went backwards would re-open a stretch of events the run's total
      // already holds, and that total is a figure the user checks against their
      // own bill.
      await dao.createPending('run-1', 'node-a');
      await dao.rememberCursorSpendThrough('run-1', 'node-a', 'conv-1', 2000);

      await dao.rememberCursorSpendThrough('run-1', 'node-a', 'conv-1', 1000);

      expect((await marks()).get('conv-1')).toBe(2000);
    });

    // One node holds a conversation per call to it. A single mark per node put
    // a late-billed event of the older conversation behind the newer one's.
    it('keeps a SEPARATE mark per conversation of one node', async () => {
      await dao.createPending('run-1', 'node-a');

      await dao.rememberCursorSpendThrough('run-1', 'node-a', 'conv-1', 5000);
      await dao.rememberCursorSpendThrough('run-1', 'node-a', 'conv-2', 1000);

      const held = await marks();
      expect(held.get('conv-1')).toBe(5000);
      expect(held.get('conv-2')).toBe(1000);
    });

    it('writes nothing for a non-positive mark, or for a row that does not exist', async () => {
      await dao.createPending('run-1', 'node-a');

      await dao.rememberCursorSpendThrough('run-1', 'node-a', 'conv-1', 0);
      await expect(
        dao.rememberCursorSpendThrough(
          'missing-run',
          'missing-node',
          'conv-1',
          5000,
        ),
      ).resolves.toBeUndefined();

      const row = await new NodeStateDao(orm.em.fork()).getByRunNode(
        'run-1',
        'node-a',
      );
      expect(row?.cursorSpendThrough).toBeNull();
    });
  });

  describe('addCursorSpend', () => {
    const read = () =>
      new NodeStateDao(orm.em.fork()).getByRunNode('run-1', 'node-a');
    const delta = (
      cents: number,
      priced: boolean,
      seedCents = 0,
    ): Parameters<NodeStateDao['addCursorSpend']>[2] => ({
      cents,
      events: 1,
      priced,
      seed: { cents: seedCents, events: seedCents > 0 ? 3 : 0 },
    });

    it('starts a never-priced node from the run’s figure, then ADDS each later poll', async () => {
      // A run holding one conversation already recorded that node's whole
      // price; starting from zero would drop it, adding the seed twice would
      // double it.
      await dao.createPending('run-1', 'node-a');

      await dao.addCursorSpend('run-1', 'node-a', delta(50, true, 700));
      await dao.addCursorSpend('run-1', 'node-a', delta(25, true, 700));

      const row = await read();
      expect(row?.cursorCostCents).toBe(775);
      expect(row?.cursorCostEvents).toBe(5);
    });

    it('takes the LARGER figure on the run’s one-time re-baseline, rather than adding', async () => {
      await dao.createPending('run-1', 'node-a');
      await dao.addCursorSpend('run-1', 'node-a', delta(400, true));

      await dao.addCursorSpend('run-1', 'node-a', delta(300, false, 900));

      expect((await read())?.cursorCostCents).toBe(400);
    });

    it('writes nothing for a row that does not exist', async () => {
      await expect(
        dao.addCursorSpend('missing-run', 'missing-node', delta(10, true)),
      ).resolves.toBeUndefined();
    });
  });

  describe('rememberWork', () => {
    it('SUMS across turns rather than replacing — the whole difference from rememberContext', async () => {
      // The one assertion that separates an accumulator from the last-write-wins
      // shape beside it: under a `data.workedMs = workedMs` writer this reads
      // 300/2 — the last turn's work reported as the node's whole history.
      await dao.createPending('run-1', 'node-a');

      await dao.rememberWork('run-1', 'node-a', 500, 3);
      await dao.rememberWork('run-1', 'node-a', 300, 2);

      const row = await new NodeStateDao(orm.em.fork()).getByRunNode(
        'run-1',
        'node-a',
      );
      expect(row?.workedMs).toBe(800);
      expect(row?.toolCalls).toBe(5);
    });

    it('a turn reporting no timing leaves the time already counted alone', async () => {
      // Every ACP agent reports no duration, so this is the ordinary case rather
      // than a degenerate one: the tool count must still accumulate while the
      // clock stands, or a cursor node would show neither figure.
      await dao.createPending('run-1', 'node-a');
      await dao.rememberWork('run-1', 'node-a', 500, 3);

      await dao.rememberWork('run-1', 'node-a', null, 2);

      const row = await new NodeStateDao(orm.em.fork()).getByRunNode(
        'run-1',
        'node-a',
      );
      expect(row?.workedMs).toBe(500);
      expect(row?.toolCalls).toBe(5);
    });

    it('leaves both figures null when the turn carries nothing positive', async () => {
      // Enters the early return. Null is "never measured" downstream, and the
      // panel omits an unmeasured figure — so a zero written here would draw
      // `0s · 0 tools` under an agent nobody timed.
      await dao.createPending('run-1', 'node-a');

      await dao.rememberWork('run-1', 'node-a', 0, 0);

      const row = await new NodeStateDao(orm.em.fork()).getByRunNode(
        'run-1',
        'node-a',
      );
      expect(row?.workedMs).toBeNull();
      expect(row?.toolCalls).toBeNull();
    });

    it('writes nothing for a runId/nodeId pair with no row, and does not throw', async () => {
      await expect(
        dao.rememberWork('missing-run', 'missing-node', 500, 3),
      ).resolves.toBeUndefined();

      // "Writes nothing" is the claim, so read it back: a writer that CREATED
      // the row would resolve undefined just as quietly.
      const row = await new NodeStateDao(orm.em.fork()).getByRunNode(
        'missing-run',
        'missing-node',
      );
      expect(row).toBeNull();
    });
  });
});
