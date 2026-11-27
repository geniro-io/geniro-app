import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { metricLedgerDb } from '../__tests__/metric-ledger-db';
import { ToolCallLogRetentionService } from './tool-call-log-retention.service';
import {
  USAGE_BACKFILL_WINDOW,
  UsageCounterBackfillService,
} from './usage-counter-backfill.service';

type Db = Awaited<ReturnType<typeof metricLedgerDb>>;

const DAY = 24 * 60 * 60_000;

describe('UsageCounterBackfillService', () => {
  let db: Db;

  beforeEach(async () => {
    db = await metricLedgerDb();
    await db.seedRun('r1', { projectId: 'p1' });
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  let seq = 0;
  const journal = async (
    occurredAt: number,
    extra: {
      tool?: string;
      ok?: boolean;
      durationMs?: number | null;
      runId?: string;
    } = {},
  ): Promise<void> => {
    seq += 1;
    await db.ledger.insertToolCall({
      runId: extra.runId ?? 'r1',
      seq,
      occurredAt: new Date(occurredAt),
      teamSlug: null,
      memberId: null,
      agentKind: 'claude',
      tool: extra.tool ?? 'Read',
      mcpServer: null,
      ok: extra.ok ?? true,
      durationMs: extra.durationMs === undefined ? 100 : extra.durationMs,
    });
  };

  const backfillFrom = async (cutoff: number) => {
    await db.counterDao.ensureBackfill(cutoff);
    return new UsageCounterBackfillService(db.em, db.counterDao, db.runDao);
  };

  const totals = async () =>
    (await db.counterDao.rows()).map((row) => ({
      subject: row.subject,
      projectId: row.projectId,
      calls: row.calls,
      errors: row.errors,
      timedCalls: row.timedCalls,
      durationMsTotal: row.durationMsTotal,
      firstAt: row.firstAt,
      lastAt: row.lastAt,
    }));

  it('folds only the rows before the cutoff, once, and a second pass adds nothing', async () => {
    await journal(1_000, { ok: false });
    await journal(2_000, { durationMs: null });
    await journal(9_000);
    const backfill = await backfillFrom(5_000);
    await backfill.onModuleInit();

    await backfill.runQuietly();
    await backfill.runQuietly();
    await (await backfillFrom(5_000)).runQuietly();

    expect(await totals()).toEqual([
      {
        subject: 'Read',
        projectId: 'p1',
        calls: 2,
        errors: 1,
        timedCalls: 1,
        durationMsTotal: 100,
        firstAt: 1_000,
        lastAt: 2_000,
      },
    ]);
    expect(backfill.done).toBe(true);
  });

  it('resumes at its cursor after a kill, rows sharing a millisecond included, with the totals of an unbroken pass', async () => {
    for (let i = 0; i < USAGE_BACKFILL_WINDOW + 3; i += 1) {
      await journal(1_000 + Math.floor(i / 7), {
        tool: i % 2 === 0 ? 'Read' : 'Bash',
      });
    }
    const killed = await backfillFrom(1_000_000);
    await killed.onModuleInit();
    expect(await killed.foldWindow()).toBe(true);

    const resumed = await backfillFrom(1_000_000);
    await resumed.onModuleInit();
    await resumed.runQuietly();

    const calls = (await db.counterDao.rows()).reduce(
      (sum, row) => sum + row.calls,
      0,
    );
    expect(calls).toBe(USAGE_BACKFILL_WINDOW + 3);
    expect(resumed.done).toBe(true);
  });

  it('counts a deleted run under no project', async () => {
    await journal(1_000, { runId: 'gone' });
    const backfill = await backfillFrom(5_000);
    await backfill.onModuleInit();

    await backfill.runQuietly();

    expect((await totals())[0]).toMatchObject({ projectId: '', calls: 1 });
  });
});

describe('ToolCallLogRetentionService', () => {
  let db: Db;

  beforeEach(async () => {
    db = await metricLedgerDb();
    await db.seedRun('r1');
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  const now = Date.UTC(2026, 10, 27);
  let seq = 0;
  const journalAt = async (daysAgo: number): Promise<void> => {
    seq += 1;
    await db.ledger.insertToolCall({
      runId: 'r1',
      seq,
      occurredAt: new Date(now - daysAgo * DAY),
      teamSlug: null,
      memberId: null,
      agentKind: null,
      tool: 'Read',
      mcpServer: null,
      ok: true,
      durationMs: null,
    });
  };

  const retentionAfterBackfill = async () => {
    const backfill = new UsageCounterBackfillService(
      db.em,
      db.counterDao,
      db.runDao,
    );
    await backfill.onModuleInit();
    await backfill.runQuietly();
    return new ToolCallLogRetentionService(db.counterDao, backfill);
  };

  it('deletes nothing until the desktop app pushed a retention', async () => {
    await journalAt(400);
    const retention = await retentionAfterBackfill();

    expect(await retention.sweep(now)).toBe(0);
    expect(await db.ledger.toolCalls({})).toHaveLength(1);
  });

  it('deletes nothing while the backfill has not finished', async () => {
    await journalAt(400);
    const backfill = new UsageCounterBackfillService(
      db.em,
      db.counterDao,
      db.runDao,
    );
    await backfill.onModuleInit();
    const retention = new ToolCallLogRetentionService(db.counterDao, backfill);
    retention.configure(90);

    expect(await retention.sweep(now)).toBe(0);
  });

  it('deletes only rows older than the window, in windows of at most 1,000, and never the counters', async () => {
    for (let i = 0; i < 1_005; i += 1) {
      await journalAt(100);
    }
    await journalAt(10);
    const retention = await retentionAfterBackfill();
    const countersBefore = await db.counterDao.rows();
    retention.configure(90);

    expect(await retention.sweep(now)).toBe(1_005);
    expect(await db.ledger.toolCalls({})).toHaveLength(1);
    expect(await db.counterDao.rows()).toEqual(countersBefore);
  });

  it('keeps everything when set to keep forever', async () => {
    await journalAt(4_000);
    const retention = await retentionAfterBackfill();
    retention.configure(null);

    expect(await retention.sweep(now)).toBe(0);
  });
});
