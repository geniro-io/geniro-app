import {
  defineConfig,
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

import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { UsageEventDao } from '../dao/usage-event.dao';
import { UsageEvent } from '../entity/usage-event.entity';
import { UsageBackfillService } from './usage-backfill.service';

/**
 * Driven against a real in-memory database with the real DAOs, not fakes: the
 * sweep's whole contract is about how four tables line up — which transcript
 * rows are candidates, which the ledger already holds, and where each turn's
 * dimensions come from — and a fake of any of them would be the spec asserting
 * its own arrangement back to itself.
 */
describe('UsageBackfillService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: UsageBackfillService;
  let itemDao: ItemDao;
  let runDao: RunDao;
  let nodeStateDao: NodeStateDao;
  let usageDao: UsageEventDao;

  const USAGE = {
    usage: {
      costUsd: 0.4,
      inputTokens: 800,
      outputTokens: 150,
      cacheReadTokens: 40,
      cacheCreationTokens: 5,
      thinkingTokens: 3,
      durationMs: 2_000,
      apiMs: 1_500,
    },
    stopReason: 'end_turn',
  };

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState, UsageEvent],
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
    itemDao = new ItemDao(em);
    runDao = new RunDao(em);
    nodeStateDao = new NodeStateDao(em);
    usageDao = new UsageEventDao(em);
    service = new UsageBackfillService(
      em,
      itemDao,
      runDao,
      nodeStateDao,
      usageDao,
    );
  });

  async function turn(
    runId: string,
    seq: number,
    payload: unknown = USAGE,
    nodeId: string | null = null,
  ): Promise<Item> {
    return itemDao.create({
      runId,
      nodeId,
      seq,
      kind: 'turn_complete',
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  }

  it('recovers finished turns that predate the ledger, with their run’s dimensions', async () => {
    await runDao.create({
      id: 'run-a',
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work/project',
    });
    await turn('run-a', 1);
    await turn('run-a', 3);

    const result = await service.backfill();

    expect(result).toEqual({ recovered: 2, scanned: 2 });
    const rows = await usageDao.getAll({});
    expect(rows.map((row) => row.seq).sort()).toEqual([1, 3]);
    expect(rows[0]).toMatchObject({
      runId: 'run-a',
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work/project',
      costUsd: 0.4,
      inputTokens: 800,
    });
  });

  it('dates each turn by its transcript row, not by when the sweep ran', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    const item = await turn('run-a', 0);

    await service.backfill();

    const [row] = await usageDao.getAll({});
    // The recovered row must sit on the day the turn happened — otherwise a
    // year of history collapses onto the day the ledger was introduced.
    expect(row!.occurredAt.getTime()).toBe(item.createdAt.getTime());
  });

  it('is safe to run on every boot — a second sweep recovers nothing', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await turn('run-a', 0);
    await turn('run-a', 1);

    expect((await service.backfill()).recovered).toBe(2);
    const second = await service.backfill();

    expect(second).toEqual({ recovered: 0, scanned: 2 });
    expect(await usageDao.getAll({})).toHaveLength(2);
  });

  it('picks up only the turns the live recorder missed', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await turn('run-a', 0);
    await turn('run-a', 1);
    // The shape a crash leaves behind: the recorder got the first turn in, then
    // the daemon died between the second turn's item write and its ledger write.
    await usageDao.recordOnce({
      runId: 'run-a',
      nodeId: null,
      seq: 0,
      occurredAt: new Date('2026-08-01T00:00:00.000Z'),
      agentKind: 'claude',
      model: null,
      cwd: null,
      costUsd: 0.4,
      inputTokens: 800,
      outputTokens: 150,
      cacheReadTokens: 40,
      cacheCreationTokens: 5,
      thinkingTokens: 3,
      durationMs: 2_000,
      apiMs: 1_500,
    });

    expect((await service.backfill()).recovered).toBe(1);
    expect((await usageDao.getAll({})).map((row) => row.seq).sort()).toEqual([
      0, 1,
    ]);
  });

  it('ignores transcript rows that are not finished turns', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await itemDao.create({
      runId: 'run-a',
      seq: 0,
      kind: 'message',
      payload: JSON.stringify({ text: 'hello' }),
    });
    await itemDao.create({
      runId: 'run-a',
      seq: 1,
      kind: 'tool_call',
      payload: JSON.stringify({ name: 'ls' }),
    });

    expect(await service.backfill()).toEqual({ recovered: 0, scanned: 0 });
    expect(await usageDao.getAll({})).toHaveLength(0);
  });

  it('skips a turn that reported no usage, and one whose payload will not parse', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await turn('run-a', 0, { stopReason: 'end_turn' });
    await turn('run-a', 1, 'not json {');
    await turn('run-a', 2);

    const result = await service.backfill();

    // One bad row costs its own turn's accounting and nothing else — the sweep
    // still recovers the rest of the history around it.
    expect(result.recovered).toBe(1);
    expect((await usageDao.getAll({})).map((row) => row.seq)).toEqual([2]);
  });

  it('attributes a workflow node’s turn to the node’s own agent and model', async () => {
    // A workflow run names no single agent; reading the run alone would leave
    // every node's spend unattributed.
    await runDao.create({
      id: 'run-w',
      workflowId: 'wf-1',
      agentKind: null,
      model: null,
      cwd: '/work/project',
    });
    await nodeStateDao.create({
      runId: 'run-w',
      nodeId: 'node-2',
      agentKind: 'cursor-agent',
      model: 'composer-1',
    });
    await turn('run-w', 0, USAGE, 'node-2');

    await service.backfill();

    expect((await usageDao.getAll({}))[0]).toMatchObject({
      nodeId: 'node-2',
      agentKind: 'cursor-agent',
      model: 'composer-1',
      cwd: '/work/project',
    });
  });

  it('recovers an orphaned turn whose run row is already gone', async () => {
    // `Item.runId` carries no FK, so a straggling write can outlive its run.
    // Losing the money because the dimensions are unknown would be the exact
    // failure this ledger exists to prevent.
    await turn('run-vanished', 0);

    expect((await service.backfill()).recovered).toBe(1);
    expect((await usageDao.getAll({}))[0]).toMatchObject({
      runId: 'run-vanished',
      agentKind: null,
      model: null,
      cwd: null,
      costUsd: 0.4,
    });
  });

  it('re-reads only what happened since the ledger’s newest turn', async () => {
    // The bound that stops launch cost growing with total history. The first
    // sweep seeds everything; later ones read back from the newest recorded
    // turn less a day of overlap.
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    const recent = await turn('run-a', 0);
    await service.backfill();

    // A turn far older than the watermark, written straight into the transcript
    // without going through the ledger — the shape the sweep no longer reaches.
    const ancient = await itemDao.create({
      runId: 'run-old',
      seq: 0,
      kind: 'turn_complete',
      payload: JSON.stringify(USAGE),
    });
    // `createdAt` is set by the entity, so back-date it through the DB
    // directly — this is the row a long-idle install would already hold.
    await orm.em
      .fork()
      .nativeUpdate(
        Item,
        { id: ancient.id },
        { createdAt: new Date(recent.createdAt.getTime() - 5 * 86_400_000) },
      );

    const second = await service.backfill();

    // Deliberately NOT recovered: bounding the sweep is the trade, and it is
    // safe because the only turns it can miss are ones a crash left behind
    // MILLISECONDS before a newer turn was recorded — the overlap covers that
    // by a day, not by five.
    expect(second.recovered).toBe(0);
    expect(second.scanned).toBe(1);
    expect(await usageDao.getAll({})).toHaveLength(1);
  });

  it('still recovers a turn the recorder missed within the overlap window', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await turn('run-a', 0);
    await service.backfill();

    // The real crash shape: a turn written to the transcript moments after the
    // last recorded one, with the daemon dying before its ledger write.
    await turn('run-a', 1);

    expect((await service.backfill()).recovered).toBe(1);
    expect(await usageDao.getAll({})).toHaveLength(2);
  });

  it('does nothing on an empty database', async () => {
    expect(await service.backfill()).toEqual({ recovered: 0, scanned: 0 });
  });

  it('lets the daemon boot when the sweep itself fails', async () => {
    // The catch in `onModuleInit` is the difference between a page with gaps
    // and a daemon that refuses to start. Nothing entered it before, so a
    // later "this is unreachable" cleanup would have turned a seeding failure
    // into a launch failure with a green suite.
    const broken = new UsageBackfillService(
      orm.em.fork(),
      {
        allTurnCompleteRows: async () => {
          throw new Error('database is locked');
        },
      } as unknown as ItemDao,
      runDao,
      nodeStateDao,
      usageDao,
    );
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});

    await expect(broken.onModuleInit()).resolves.toBeUndefined();

    expect(String(warn.mock.calls[0]?.[0])).toContain('database is locked');
    warn.mockRestore();
  });
});
