import { describe, expect, it } from 'vitest';

import type { AccountSpendEvent } from '../adapters/adapter.types';
import {
  type ConversationSpend,
  ledgerTotals,
  readPolledSpendLedger,
  readSpendBucket,
  spendBucket,
  unpricedConversation,
  withAccountEvents,
  writePolledSpendLedger,
} from './polled-spend-ledger';

function charge(
  key: string,
  atMs: number,
  cents: number,
  model: string | null = 'grok-4.7',
): AccountSpendEvent {
  return { conversationId: 'conv', key, atMs, cents, model };
}

describe('withAccountEvents', () => {
  it('replaces an open event’s figure with the one read now', () => {
    const before: ConversationSpend = {
      ...unpricedConversation(0),
      open: { a: [100, 5, 'grok-4.7'] },
    };

    expect(
      withAccountEvents(before, [charge('a', 100, 50)], null).open,
    ).toEqual({ a: [100, 50, 'grok-4.7'] });
  });

  it('ignores an event dated before the settled boundary — it is already in the sum', () => {
    const before: ConversationSpend = {
      settled: { [spendBucket(500, 'grok-4.7')]: [30, 1] },
      settledThroughMs: 1_000,
      open: {},
    };

    expect(withAccountEvents(before, [charge('old', 999, 30)], null)).toEqual(
      before,
    );
  });

  it('folds events older than the settle point into their day-and-model bucket and moves the boundary', () => {
    const after = withAccountEvents(
      unpricedConversation(0),
      [
        charge('a', 100, 5),
        charge('b', 500, 7),
        charge('free', 200, 0),
        charge('kimi', 150, 3, 'kimi-k3'),
      ],
      300,
    );

    expect(after).toEqual({
      settled: {
        [spendBucket(100, 'grok-4.7')]: [5, 1],
        [spendBucket(150, 'kimi-k3')]: [3, 1],
      },
      settledThroughMs: 300,
      open: { b: [500, 7, 'grok-4.7'] },
    });
  });

  it('never moves the boundary backwards', () => {
    const before: ConversationSpend = { ...unpricedConversation(1_000) };

    expect(withAccountEvents(before, [], 500).settledThroughMs).toBe(1_000);
  });
});

describe('ledgerTotals', () => {
  it('sums settled and open charges per bucket, counting only the events that cost something', () => {
    const day = spendBucket(1, 'grok-4.7');
    const ledger = new Map<string, ConversationSpend>([
      [
        'a',
        {
          settled: { [day]: [10, 2] },
          settledThroughMs: 0,
          open: { x: [1, 3, 'grok-4.7'] },
        },
      ],
      [
        'b',
        {
          ...unpricedConversation(0),
          open: { y: [1, 0, 'grok-4.7'], z: [2, 4, 'kimi-k3'] },
        },
      ],
    ]);

    const totals = ledgerTotals(ledger);

    expect({ cents: totals.cents, events: totals.events }).toEqual({
      cents: 17,
      events: 4,
    });
    expect(Object.fromEntries(totals.buckets)).toEqual({
      [day]: { cents: 13, events: 3 },
      [spendBucket(2, 'kimi-k3')]: { cents: 4, events: 1 },
    });
  });
});

describe('spendBucket', () => {
  it('files a charge under its LOCAL calendar day and its model', () => {
    const at = new Date(2026, 8, 30, 23, 59).getTime();

    expect(spendBucket(at, 'grok-4.7')).toBe('2026-09-30|grok-4.7');
    expect(readSpendBucket('2026-09-30|grok-4.7')).toEqual({
      day: '2026-09-30',
      model: 'grok-4.7',
    });
    expect(readSpendBucket(spendBucket(at, ''))).toEqual({
      day: '2026-09-30',
      model: '',
    });
  });
});

describe('readPolledSpendLedger', () => {
  it('round-trips what it writes', () => {
    const ledger = new Map<string, ConversationSpend>([
      [
        'a',
        {
          settled: { '2026-09-30|grok-4.7': [1.5, 1] },
          settledThroughMs: 9,
          open: { k: [10, 2, 'kimi-k3'] },
        },
      ],
    ]);

    expect(readPolledSpendLedger(writePolledSpendLedger(ledger))).toEqual(
      ledger,
    );
  });

  it('writes null for an empty ledger', () => {
    expect(writePolledSpendLedger(new Map())).toBeNull();
  });

  it('reads an unreadable column, or an entry of the wrong shape, as never priced', () => {
    expect(readPolledSpendLedger('not json').size).toBe(0);
    expect(readPolledSpendLedger('[1,2]').size).toBe(0);
    // The watermark shape the ledger replaced is NOT a ledger entry.
    expect(readPolledSpendLedger('{"conv":1790000000000}').size).toBe(0);
    // Nor is an open event that names no model.
    expect(
      readPolledSpendLedger(
        '{"conv":{"settled":{},"settledThroughMs":1,"open":{"k":[1,2]}}}',
      ).size,
    ).toBe(0);
  });
});
