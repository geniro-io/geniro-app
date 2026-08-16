import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { UsageEvent } from '../entity/usage-event.entity';
import type { UsageEventInput } from '../stats.types';
import { UsageEventDao } from './usage-event.dao';

/**
 * Real-driver DAO spec, mirroring `item.dao.spec.ts`: the aggregation service's
 * own spec runs an in-memory fake that only MIRRORS these queries, so this suite
 * boots MikroORM on an in-memory better-sqlite3 database with the real entity
 * and executes the actual SQL — the half-open range, the projections, and the
 * unique index that is the ledger's last line of defence against counting a
 * turn's spend twice.
 */
describe('UsageEventDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: UsageEventDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [UsageEvent],
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
    dao = new UsageEventDao(orm.em.fork());
  });

  function input(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
    return {
      runId: 'run-a',
      nodeId: null,
      seq: 0,
      occurredAt: new Date('2026-08-10T12:00:00.000Z'),
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work/project',
      costUsd: 0.25,
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
      thinkingTokens: 5,
      durationMs: 4_000,
      apiMs: 3_000,
      ...overrides,
    };
  }

  describe('recordOnce', () => {
    it('writes the turn and round-trips every figure', async () => {
      expect(await dao.recordOnce(input())).toBe(true);

      const rows = await dao.getAll({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        runId: 'run-a',
        nodeId: null,
        seq: 0,
        agentKind: 'claude',
        model: 'claude-opus-5',
        cwd: '/work/project',
        costUsd: 0.25,
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 50,
        cacheCreationTokens: 10,
        thinkingTokens: 5,
        durationMs: 4_000,
        apiMs: 3_000,
      });
      expect(rows[0]!.occurredAt.toISOString()).toBe(
        '2026-08-10T12:00:00.000Z',
      );
    });

    it('keeps a null figure null — never coerced to zero', async () => {
      // The cursor-agent shape: tokens reported, everything else not measured.
      await dao.recordOnce(
        input({
          agentKind: 'cursor-agent',
          costUsd: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          thinkingTokens: null,
          durationMs: null,
          apiMs: null,
        }),
      );

      const [row] = await dao.getAll({});
      expect(row!.costUsd).toBeNull();
      expect(row!.cacheReadTokens).toBeNull();
      expect(row!.thinkingTokens).toBeNull();
      expect(row!.durationMs).toBeNull();
      expect(row!.apiMs).toBeNull();
    });

    it('refuses a turn it already holds, and reports that it wrote nothing', async () => {
      expect(await dao.recordOnce(input({ seq: 3 }))).toBe(true);
      // A re-record of the SAME turn carrying a different cost — the shape a
      // backfill re-run produces. It must neither add a row nor overwrite one.
      expect(await dao.recordOnce(input({ seq: 3, costUsd: 99 }))).toBe(false);

      const rows = await dao.getAll({});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.costUsd).toBe(0.25);
    });

    it('scopes the idempotency key to the run — same seq in another run is a different turn', async () => {
      await dao.recordOnce(input({ runId: 'run-a', seq: 0 }));

      expect(await dao.recordOnce(input({ runId: 'run-b', seq: 0 }))).toBe(
        true,
      );
      expect(await dao.getAll({})).toHaveLength(2);
    });
  });

  it('has a database-level unique index behind the recordOnce check', async () => {
    // Driven through `create`, deliberately BYPASSING recordOnce's own read —
    // otherwise this would re-test the guard rather than the backstop under it,
    // and dropping @Unique from the entity would leave the suite green.
    await dao.create(input({ seq: 7 }));

    await expect(dao.create(input({ seq: 7 }))).rejects.toThrow();
  });

  describe('inRange', () => {
    it('is half-open — the lower bound is included, the upper excluded', async () => {
      await dao.recordOnce(
        input({ seq: 0, occurredAt: new Date('2026-08-10T00:00:00.000Z') }),
      );
      await dao.recordOnce(
        input({ seq: 1, occurredAt: new Date('2026-08-10T23:59:59.999Z') }),
      );
      await dao.recordOnce(
        input({ seq: 2, occurredAt: new Date('2026-08-11T00:00:00.000Z') }),
      );

      const rows = await dao.inRange(
        new Date('2026-08-10T00:00:00.000Z'),
        new Date('2026-08-11T00:00:00.000Z'),
      );

      // Without the half-open bound, consecutive periods would each claim the
      // midnight turn and every per-day total would count it twice.
      expect(rows.map((row) => row.seq)).toEqual([0, 1]);
    });

    it('orders by when the turn happened, not by when the row was written', async () => {
      // The backfill's shape: rows inserted newest-first, carrying old
      // timestamps. `createdAt` ordering would return these reversed.
      await dao.recordOnce(
        input({ seq: 1, occurredAt: new Date('2026-08-10T18:00:00.000Z') }),
      );
      await dao.recordOnce(
        input({ seq: 0, occurredAt: new Date('2026-08-10T06:00:00.000Z') }),
      );

      const rows = await dao.inRange(
        new Date('2026-08-10T00:00:00.000Z'),
        new Date('2026-08-11T00:00:00.000Z'),
      );

      expect(rows.map((row) => row.seq)).toEqual([0, 1]);
    });

    it('answers an empty list for a period with no turns', async () => {
      await dao.recordOnce(input());

      expect(
        await dao.inRange(
          new Date('2026-01-01T00:00:00.000Z'),
          new Date('2026-01-02T00:00:00.000Z'),
        ),
      ).toEqual([]);
    });
  });

  describe('recordedKeys', () => {
    it('returns one composite key per recorded turn', async () => {
      await dao.recordOnce(input({ runId: 'run-a', seq: 0 }));
      await dao.recordOnce(input({ runId: 'run-a', seq: 4 }));
      await dao.recordOnce(input({ runId: 'run-b', seq: 0 }));

      expect(await dao.recordedKeys()).toEqual(
        new Set(['run-a:0', 'run-a:4', 'run-b:0']),
      );
    });

    it('is empty on a fresh ledger', async () => {
      expect((await dao.recordedKeys()).size).toBe(0);
    });
  });

  describe('earliestOccurredAt', () => {
    it('answers the oldest turn the ledger holds', async () => {
      await dao.recordOnce(
        input({ seq: 0, occurredAt: new Date('2026-08-10T00:00:00.000Z') }),
      );
      await dao.recordOnce(
        input({ seq: 1, occurredAt: new Date('2026-07-01T00:00:00.000Z') }),
      );

      expect((await dao.earliestOccurredAt())?.toISOString()).toBe(
        '2026-07-01T00:00:00.000Z',
      );
    });

    it('answers null when the ledger is empty', async () => {
      expect(await dao.earliestOccurredAt()).toBeNull();
    });
  });
});
