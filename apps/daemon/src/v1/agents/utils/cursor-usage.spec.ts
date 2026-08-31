import { describe, expect, it } from 'vitest';

import {
  applyCursorSpend,
  cursorUsageRequestBody,
  cursorUsageTotalCount,
  foldCursorUsagePage,
  mergeCursorSpend,
} from './cursor-usage';

/**
 * The event shape here is TRANSCRIBED from a real reply this daemon received on
 * 2026-08-31 — the epoch-millis strings, the fractional `chargedCents`, and the
 * `conversationId` that turned out to be the ACP session id verbatim. Inventing
 * a tidier shape is how a reader of this parser comes to believe the wire is
 * tidier than it is.
 */
const event = (over: Record<string, unknown> = {}): unknown => ({
  timestamp: '1788171101936',
  model: 'gemini-3.1-pro',
  isChargeable: true,
  chargedCents: 11.058271999999999,
  conversationId: '7d781e85-8ed6-4771-8d81-b2e132fd0c2d',
  tokenUsage: { inputTokens: 52708, outputTokens: 1441 },
  ...over,
});

describe('foldCursorUsagePage', () => {
  it('sums charged cents per conversation', () => {
    const fold = foldCursorUsagePage({
      usageEventsDisplay: [
        event(),
        event({ chargedCents: 1, timestamp: '1788171101999' }),
      ],
    });
    const one = fold.get('7d781e85-8ed6-4771-8d81-b2e132fd0c2d');
    expect(one?.costCents).toBeCloseTo(12.058272, 6);
    expect(one?.events).toBe(2);
    expect(one?.latestAtMs).toBe(1788171101999);
  });

  it('keeps two conversations apart', () => {
    const fold = foldCursorUsagePage({
      usageEventsDisplay: [event(), event({ conversationId: 'other' })],
    });
    expect([...fold.keys()].sort()).toEqual([
      '7d781e85-8ed6-4771-8d81-b2e132fd0c2d',
      'other',
    ]);
  });

  it('DROPS an event with no conversation id rather than pooling it', () => {
    // The one failure this whole approach exists to avoid is attributing a
    // charge to the wrong thread, so an unattributable event costs its own
    // cents and never somebody else's total.
    const fold = foldCursorUsagePage({
      usageEventsDisplay: [event({ conversationId: '' }), event()],
    });
    expect(fold.size).toBe(1);
    expect(fold.get('7d781e85-8ed6-4771-8d81-b2e132fd0c2d')?.events).toBe(1);
  });

  it('skips an event the account was not charged for', () => {
    const fold = foldCursorUsagePage({
      usageEventsDisplay: [event({ isChargeable: false })],
    });
    expect(fold.size).toBe(0);
  });

  it('answers empty on a reply it cannot read', () => {
    expect(foldCursorUsagePage(null).size).toBe(0);
    expect(foldCursorUsagePage({ usageEventsDisplay: 'nope' }).size).toBe(0);
    expect(foldCursorUsagePage({}).size).toBe(0);
  });
});

describe('mergeCursorSpend', () => {
  it('adds a later page into the running fold', () => {
    const into = foldCursorUsagePage({ usageEventsDisplay: [event()] });
    mergeCursorSpend(
      into,
      foldCursorUsagePage({
        usageEventsDisplay: [event({ chargedCents: 5 })],
      }),
    );
    const one = into.get('7d781e85-8ed6-4771-8d81-b2e132fd0c2d');
    expect(one?.events).toBe(2);
    expect(one?.costCents).toBeCloseTo(16.058272, 6);
  });
});

describe('cursorUsageTotalCount', () => {
  it('reads the count whether it arrives as a number or a string', () => {
    expect(cursorUsageTotalCount({ totalUsageEventsCount: 15 })).toBe(15);
    expect(cursorUsageTotalCount({ totalUsageEventsCount: '15' })).toBe(15);
    expect(cursorUsageTotalCount({})).toBeNull();
  });
});

describe('cursorUsageRequestBody', () => {
  it('sends the bounds as epoch-millis STRINGS, which is what the wire takes', () => {
    const body: unknown = JSON.parse(
      cursorUsageRequestBody({
        teamId: 1,
        userId: 2,
        startMs: 100,
        endMs: 200,
        page: 3,
      }),
    );
    expect(body).toMatchObject({
      teamId: 1,
      userId: 2,
      startDate: '100',
      endDate: '200',
      page: 3,
    });
  });
});

describe('applyCursorSpend', () => {
  const totals = { costUsd: null, costedTurns: 0, turns: 4 };

  it('puts the fetched cents on as dollars', () => {
    const out = applyCursorSpend(totals, {
      cursorCostCents: 1436.9128770000002,
      cursorCostEvents: 3,
    });
    expect(out.costUsd).toBeCloseTo(14.36912877, 8);
    expect(out.costedTurns).toBe(3);
    // Everything it was not asked about survives.
    expect(out.turns).toBe(4);
  });

  it('leaves a run nothing has priced ALONE, rather than claiming zero', () => {
    // A null cost is what the header draws as "no cost reported"; a zero would
    // say the thread was free, which is a different and false statement.
    expect(
      applyCursorSpend(totals, {
        cursorCostCents: null,
        cursorCostEvents: null,
      }),
    ).toEqual(totals);
    expect(
      applyCursorSpend(totals, {
        cursorCostCents: 0,
        cursorCostEvents: 0,
      }),
    ).toEqual(totals);
  });
});
