import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CallContext } from '../../runs/entity/call-context.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import {
  CALL_CONTEXT_SNAPSHOT_LIMIT,
  CallContextDao,
} from './call-context.dao';

/**
 * Real-driver DAO spec (see item.dao.spec for the harness rationale). What it
 * pins is the reason this table exists at all: a reading is keyed by CALL, so
 * two calls a node holds at once keep separate figures instead of overwriting
 * one row.
 *
 * `NodeState` is registered beside it because the DAO asks about the calling
 * node before it creates anything — see `rememberContext`.
 */
describe('CallContextDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: CallContextDao;

  /** The `node_state` row a real run seeds before any node executes. */
  async function seedNode(runId: string, nodeId: string): Promise<void> {
    const em = orm.em.fork();
    em.create(
      NodeState,
      { runId, nodeId, status: 'pending' },
      { partial: true },
    );
    await em.flush();
  }

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [CallContext, NodeState],
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
    dao = new CallContextDao(orm.em.fork());
    await seedNode('run-1', 'node-a');
    await seedNode('run-2', 'node-a');
  });

  it("creates the row on a call's first reading, there being no seed for one", async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', 4200, 200000);

    const rows = await dao.listByRun('run-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: 'run-1',
      callId: 'call-1',
      nodeId: 'node-a',
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });
  });

  it('keeps one row per CALL when a single node holds several at once', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', 4200, 200000);
    await dao.rememberContext('run-1', 'call-2', 'node-a', 91000, 200000);

    const rows = await dao.listByRun('run-1');
    expect(rows).toHaveLength(2);
    expect(
      Object.fromEntries(rows.map((row) => [row.callId, row.contextTokens])),
    ).toEqual({ 'call-1': 4200, 'call-2': 91000 });
  });

  it('updates the existing row rather than adding a second for the same call', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', 4200, 200000);
    await dao.rememberContext('run-1', 'call-1', 'node-a', 9100, 200000);

    const rows = await dao.listByRun('run-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contextTokens).toBe(9100);
  });

  it('never clears a stored window with a reading that omits it', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', 4200, 200000);
    // A `context_progress` carries a count and no window — the shape that would
    // erase the denominator if the absent half were written as null.
    await dao.rememberContext('run-1', 'call-1', 'node-a', 5300, null);

    const rows = await dao.listByRun('run-1');
    expect(rows[0]).toMatchObject({
      contextTokens: 5300,
      contextWindowTokens: 200000,
    });
  });

  it('never clears a stored count with a reading that omits it', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', 4200, null);
    await dao.rememberContext('run-1', 'call-1', 'node-a', null, 200000);

    const rows = await dao.listByRun('run-1');
    expect(rows[0]).toMatchObject({
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });
  });

  it('stores no row at all for a reading whose every figure is non-positive', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', 0, 0);

    expect(await dao.listByRun('run-1')).toHaveLength(0);
  });

  it('rejects a zero figure while storing the positive one beside it', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', 0, 200000);

    const rows = await dao.listByRun('run-1');
    expect(rows[0]).toMatchObject({
      contextTokens: null,
      contextWindowTokens: 200000,
    });
  });

  it('scopes the listing to one run', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', 4200, 200000);
    await dao.rememberContext('run-2', 'call-1', 'node-a', 7300, 200000);

    const rows = await dao.listByRun('run-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contextTokens).toBe(4200);
  });

  it('creates nothing for a node whose state row is already gone', async () => {
    // The straggler case: a run teardown destroys node states BEFORE call
    // contexts, so a reading arriving in that window would otherwise insert a
    // row that `getNodeStates` can never return — it maps over node states and
    // looks calls up beside them, so a call with no node is unreachable.
    await dao.rememberContext(
      'run-1',
      'call-1',
      'node-torn-down',
      4200,
      200000,
    );

    expect(await dao.listByRun('run-1')).toHaveLength(0);
  });

  it('still records a call on a node that DOES have a state row', async () => {
    // The other side of the guard, so a refusal that swallowed everything could
    // not pass the test above.
    await seedNode('run-1', 'node-b');
    await dao.rememberContext('run-1', 'call-1', 'node-b', 4200, 200000);

    expect(await dao.listByRun('run-1')).toHaveLength(1);
  });

  it('caps the snapshot at the newest calls, and returns them oldest-first', async () => {
    // Timestamps are written by hand rather than let the clock assign them:
    // hundreds of inserts land inside the same millisecond, and ordering on a
    // tie is undefined — which would make the assertion below flaky rather than
    // wrong. Distinct values make "which rows survive the cap" answerable.
    const em = orm.em.fork();
    const overflow = 20;
    for (let i = 0; i < CALL_CONTEXT_SNAPSHOT_LIMIT + overflow; i += 1) {
      em.create(
        CallContext,
        {
          runId: 'run-1',
          callId: `call-${String(i).padStart(4, '0')}`,
          nodeId: 'node-a',
          contextTokens: 1000 + i,
          createdAt: new Date(1_000_000 + i * 1_000),
        },
        { partial: true },
      );
    }
    await em.flush();

    const rows = await dao.listByRun('run-1');
    expect(rows).toHaveLength(CALL_CONTEXT_SNAPSHOT_LIMIT);
    // The OLDEST are what fell off; the newest call is still the last element.
    expect(rows[0]!.callId).toBe(`call-${String(overflow).padStart(4, '0')}`);
    expect(rows.at(-1)!.callId).toBe(
      `call-${String(CALL_CONTEXT_SNAPSHOT_LIMIT + overflow - 1).padStart(4, '0')}`,
    );
  });
});
