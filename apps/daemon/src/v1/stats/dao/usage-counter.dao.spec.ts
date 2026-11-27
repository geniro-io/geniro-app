import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { metricLedgerDb } from '../__tests__/metric-ledger-db';
import type { UsageCounterRow } from '../stats.types';
import { emptyDelta } from '../utils/usage-counter-delta';

type Db = Awaited<ReturnType<typeof metricLedgerDb>>;

function counter(extra: Partial<UsageCounterRow>): UsageCounterRow {
  return {
    subjectKind: 'tool',
    subject: 'memory_read',
    source: 'geniro',
    agentKind: 'claude',
    origin: 'direct',
    projectId: '',
    ...emptyDelta(),
    ...extra,
  };
}

describe('UsageCounterDao', () => {
  let db: Db;

  beforeEach(async () => {
    db = await metricLedgerDb();
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  it('adds every counter onto the stored row and keeps the first and last use', async () => {
    await db.counterDao.add([
      counter({
        calls: 2,
        errors: 1,
        refused: 1,
        durationMsTotal: 300,
        timedCalls: 2,
        resultCharsTotal: 40,
        sizedCalls: 1,
        offeredSessions: 3,
        firstAt: 2_000,
        lastAt: 5_000,
      }),
    ]);
    await db.counterDao.add([
      counter({
        calls: 1,
        errors: 0,
        refused: 0,
        durationMsTotal: 100,
        timedCalls: 1,
        resultCharsTotal: 10,
        sizedCalls: 1,
        offeredSessions: 1,
        firstAt: 1_000,
        lastAt: 4_000,
      }),
    ]);

    expect(await db.counterDao.rows()).toEqual([
      counter({
        calls: 3,
        errors: 1,
        refused: 1,
        durationMsTotal: 400,
        timedCalls: 3,
        resultCharsTotal: 50,
        sizedCalls: 2,
        offeredSessions: 4,
        firstAt: 1_000,
        lastAt: 5_000,
      }),
    ]);
  });

  it('keeps a known first use when an offer with no use is added', async () => {
    await db.counterDao.add([
      counter({ calls: 1, firstAt: 1_000, lastAt: 1_000 }),
    ]);
    await db.counterDao.add([counter({ offeredSessions: 1 })]);

    const [row] = await db.counterDao.rows();
    expect(row).toMatchObject({
      calls: 1,
      offeredSessions: 1,
      firstAt: 1_000,
      lastAt: 1_000,
    });
  });

  it('sums rows that share a key inside one batch', async () => {
    await db.counterDao.add([counter({ calls: 1 }), counter({ calls: 4 })]);

    expect((await db.counterDao.rows()).map((row) => row.calls)).toEqual([5]);
  });

  it("keeps each subject's first boot and moves only its last one", async () => {
    const subject = {
      subjectKind: 'tool' as const,
      subject: 'goals',
      source: 'geniro',
    };
    await db.counterDao.registerSubjects([subject], 1_000);
    await db.counterDao.registerSubjects([subject], 9_000);
    await db.counterDao.registerSubjects([subject], 5_000);

    expect(await db.counterDao.subjects()).toEqual([
      { ...subject, firstKnownAt: 1_000, lastKnownAt: 9_000 },
    ]);
  });

  it('reads the journal before the cutoff in (occurred_at, id) order after a cursor', async () => {
    await db.seedRun('r1');
    const at = (ms: number) => new Date(ms);
    for (const [seq, ms] of [
      [1, 1_000],
      [2, 2_000],
      [3, 2_000],
      [4, 3_000],
      [5, 9_000],
    ] as const) {
      await db.ledger.insertToolCall({
        runId: 'r1',
        seq,
        occurredAt: at(ms),
        teamSlug: null,
        memberId: null,
        agentKind: 'claude',
        tool: `t${seq}`,
        mcpServer: null,
        ok: true,
        durationMs: null,
      });
    }
    const first = await db.counterDao.journalWindow(5_000, null, 2);
    const second = await db.counterDao.journalWindow(
      5_000,
      { occurredAt: first[1]?.occurredAt ?? 0, id: first[1]?.id ?? '' },
      10,
    );

    expect([...first, ...second].map((row) => row.occurredAt)).toEqual([
      1_000, 2_000, 2_000, 3_000,
    ]);
    expect(new Set([...first, ...second].map((row) => row.tool)).size).toBe(4);
  });

  it('deletes only journal rows older than the cut, at most the window it is given', async () => {
    await db.seedRun('r1');
    for (let seq = 1; seq <= 5; seq += 1) {
      await db.ledger.insertToolCall({
        runId: 'r1',
        seq,
        occurredAt: new Date(seq * 1_000),
        teamSlug: null,
        memberId: null,
        agentKind: null,
        tool: 'Read',
        mcpServer: null,
        ok: true,
        durationMs: null,
      });
    }

    expect(await db.counterDao.deleteJournalBefore(4_000, 2)).toBe(2);
    expect(await db.counterDao.deleteJournalBefore(4_000, 2)).toBe(1);
    expect(await db.counterDao.deleteJournalBefore(4_000, 2)).toBe(0);
    expect((await db.ledger.toolCalls({})).map((row) => row.seq)).toEqual([
      4, 5,
    ]);
  });
});
