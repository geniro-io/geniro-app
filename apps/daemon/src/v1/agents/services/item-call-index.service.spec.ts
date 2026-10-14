import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  defineConfig,
  EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
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
import { RunDao } from '../dao/run.dao';
import { CALL_MEMBERSHIP_VERSION } from '../utils/call-membership';
import { ItemCallIndexService } from './item-call-index.service';

describe('ItemCallIndexService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: ItemDao;
  let runs: RunDao;
  let marker: string;
  let index: ItemCallIndexService;

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
    const em = orm.em.fork() as EntityManager;
    dao = new ItemDao(em);
    runs = new RunDao(em);
    marker = join(tempDir('call-index-'), 'marker');
    index = new ItemCallIndexService(dao, runs, em, marker);
  });

  /** A row written the way a build before the column wrote it: unstamped. */
  async function legacy(
    seq: number,
    kind: ItemKind,
    nodeId: string | null,
    payload: Record<string, unknown>,
    runId = 'run-1',
  ): Promise<void> {
    await dao.create({
      runId,
      seq,
      kind,
      nodeId,
      payload: JSON.stringify(payload),
    });
  }

  async function inCallBySeq(runId = 'run-1'): Promise<(string | null)[]> {
    const rows = await dao.getByRun(runId, -1, orm.em.fork() as EntityManager);
    return rows.map((row) => row.inCall);
  }

  it("stamps an older run's rows by the call whose card each is drawn in", async () => {
    await legacy(1, 'message', 'manager', { text: 'plan' });
    await legacy(2, 'call_started', 'manager', {
      callId: 'call-1',
      calleeNodeId: 'engineer',
    });
    await legacy(3, 'tool_call', 'engineer', { id: 't1', callId: 'call-1' });
    await legacy(4, 'approval_request', 'engineer', { callId: 'call-1' });
    await legacy(5, 'call_result', 'manager', { callId: 'call-1' });

    await index.ensureIndexed('run-1');

    expect(await inCallBySeq()).toEqual(['', '', 'call-1', '', 'call-1']);
  });

  it('leaves every other run alone', async () => {
    await legacy(1, 'message', 'manager', { text: 'plan' });
    await legacy(1, 'message', 'manager', { text: 'other' }, 'run-2');

    await index.ensureIndexed('run-1');

    expect(await inCallBySeq('run-2')).toEqual([null]);
  });

  it('reads the call starts a stamped row holds when stamping the unstamped ones after it', async () => {
    // A run written across the upgrade: its call started under the new build,
    // and a row the old one wrote meanwhile still needs the start to be placed.
    await dao.create({
      runId: 'run-1',
      seq: 1,
      kind: 'call_started',
      nodeId: 'manager',
      payload: JSON.stringify({ callId: 'call-1', calleeNodeId: 'engineer' }),
      inCall: '',
    });
    await legacy(2, 'message', 'engineer', { text: 'on it', callId: 'call-1' });

    await index.ensureIndexed('run-1');

    expect(await inCallBySeq()).toEqual(['', 'call-1']);
  });

  it('stamps a row as it is written from the starts the run already holds', async () => {
    await legacy(1, 'call_started', 'manager', {
      callId: 'call-1',
      calleeNodeId: 'engineer',
    });

    expect(
      await index.inCallOf('run-1', {
        kind: 'message',
        nodeId: 'engineer',
        payload: { text: 'done', callId: 'call-1' },
      }),
    ).toBe('call-1');
  });

  it('learns a start it is asked to stamp, for the rows written after it', async () => {
    await index.inCallOf('run-1', {
      kind: 'call_started',
      nodeId: 'manager',
      payload: { callId: 'call-2', calleeNodeId: 'qa' },
    });

    expect(
      await index.inCallOf('run-1', {
        kind: 'tool_call',
        nodeId: 'qa',
        payload: { id: 't1', callId: 'call-2' },
      }),
    ).toBe('call-2');
  });

  it('stamps a row outside any call as the run’s own flow without reading the run', async () => {
    const reads = vi.spyOn(dao, 'rowsOfKinds');

    expect(
      await index.inCallOf('run-1', {
        kind: 'message',
        nodeId: 'manager',
        payload: { text: 'plan' },
      }),
    ).toBe('');
    expect(reads).not.toHaveBeenCalled();
  });

  it('stamps a run past one batch of rows', async () => {
    await legacy(0, 'call_started', 'manager', {
      callId: 'call-1',
      calleeNodeId: 'engineer',
    });
    for (let seq = 1; seq <= 600; seq += 1) {
      await legacy(seq, 'tool_call', 'engineer', {
        id: `t${seq}`,
        callId: 'call-1',
      });
    }

    await index.ensureIndexed('run-1');

    const stamped = await inCallBySeq();
    expect(stamped).toHaveLength(601);
    expect(stamped.filter((value) => value === 'call-1')).toHaveLength(600);
  });

  it('stamps a run once when two reads ask at the same time', async () => {
    await legacy(1, 'message', 'manager', { text: 'plan' });
    const reads = vi.spyOn(dao, 'unstampedRows');

    await Promise.all([
      index.ensureIndexed('run-1'),
      index.ensureIndexed('run-1'),
    ]);

    // One stamping pass: its batch, then the empty read that ends it.
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('reads a run once to know whether it can hold calls', async () => {
    await runs.create({ id: 'run-1', workflowId: 'dev-team' });
    await runs.create({ id: 'chat-1' });
    const reads = vi.spyOn(runs, 'getById');

    expect(await index.holdsCalls('run-1')).toBe(true);
    expect(await index.holdsCalls('run-1')).toBe(true);
    expect(await index.holdsCalls('chat-1')).toBe(false);

    expect(reads).toHaveBeenCalledTimes(2);
  });

  describe('the boot sweep', () => {
    it('stamps every workflow run and records the rule it stamped under', async () => {
      await runs.create({ id: 'run-1', workflowId: 'dev-team' });
      await runs.create({ id: 'run-2', workflowId: 'dev-team' });
      await legacy(1, 'message', 'manager', { text: 'a' }, 'run-1');
      await legacy(1, 'message', 'manager', { text: 'b' }, 'run-2');

      await index.indexAllQuietly();

      expect(await inCallBySeq('run-1')).toEqual(['']);
      expect(await inCallBySeq('run-2')).toEqual(['']);
      expect(readFileSync(marker, 'utf8').split('\n')[0]).toBe(
        String(CALL_MEMBERSHIP_VERSION),
      );
    });

    it('stays retired once it has finished under the current rule', async () => {
      await runs.create({ id: 'run-1', workflowId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION}\n`);
      await legacy(1, 'message', 'manager', { text: 'a' });

      await index.indexAllQuietly();

      // Left for the run's first read, which stamps it on demand.
      expect(await inCallBySeq()).toEqual([null]);
    });

    it("stamps every row again when the stamps are another rule's", async () => {
      await runs.create({ id: 'run-1', workflowId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await dao.create({
        runId: 'run-1',
        seq: 1,
        kind: 'message',
        nodeId: 'manager',
        payload: JSON.stringify({ text: 'a' }),
        inCall: 'call-stale',
      });

      await index.indexAllQuietly();

      expect(await inCallBySeq()).toEqual(['']);
    });

    it('resolves when the runs cannot be listed, and is not retired', async () => {
      vi.spyOn(runs, 'listWorkflowRuns').mockRejectedValue(new Error('locked'));

      await expect(index.indexAllQuietly()).resolves.toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    });

    it('stamps again a run whose stamping started after the sweep looked, and spans the clear', async () => {
      await runs.create({ id: 'run-1', workflowId: 'dev-team' });
      await runs.create({ id: 'run-2', workflowId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      for (let seq = 1; seq <= 600; seq += 1) {
        await legacy(seq, 'message', 'manager', { text: `m${seq}` }, 'run-2');
      }
      // run-2's first batch lands BEFORE the clear and its second after it.
      let firstBatchDone: () => void = () => undefined;
      const firstBatch = new Promise<void>((resolve) => {
        firstBatchDone = resolve;
      });
      let cleared: () => void = () => undefined;
      const clear = new Promise<void>((resolve) => {
        cleared = resolve;
      });
      const rows = dao.unstampedRows.bind(dao);
      vi.spyOn(dao, 'unstampedRows').mockImplementation(
        async (runId, afterSeq, limit, em) => {
          if (runId === 'run-2' && afterSeq > 0) {
            firstBatchDone();
            await clear;
          }
          return rows(runId, afterSeq, limit, em);
        },
      );
      const forget = dao.forgetInCalls.bind(dao);
      let reading: Promise<void> = Promise.resolve();
      vi.spyOn(dao, 'forgetInCalls').mockImplementation(async (em) => {
        reading = index.ensureIndexed('run-2');
        await firstBatch;
        const forgotten = await forget(em);
        cleared();
        return forgotten;
      });

      await index.indexAllQuietly();
      await reading;

      expect(
        (await inCallBySeq('run-2')).filter((value) => value === null),
      ).toEqual([]);
    });

    it('leaves no row unstamped when a read was stamping the run as the stamps were cleared', async () => {
      await runs.create({ id: 'run-1', workflowId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      for (let seq = 1; seq <= 600; seq += 1) {
        await legacy(seq, 'message', 'manager', { text: `m${seq}` });
      }

      await Promise.all([
        index.ensureIndexed('run-1'),
        index.indexAllQuietly(),
      ]);
      await index.ensureIndexed('run-1');

      expect((await inCallBySeq()).filter((value) => value === null)).toEqual(
        [],
      );
    });
  });
});
