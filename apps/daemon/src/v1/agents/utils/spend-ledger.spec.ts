import { describe, expect, it } from 'vitest';

import {
  type ConversationSpend,
  conversationSpend,
  readSpendLedger,
  restateConversation,
  writeSpendLedger,
} from './spend-ledger';

const spend = (over: Partial<ConversationSpend> = {}): ConversationSpend => ({
  settledBeforeMs: 0,
  settledCents: 0,
  settledEvents: 0,
  recent: [],
  ...over,
});

describe('restateConversation', () => {
  it('prices a never-priced conversation from everything the window holds', () => {
    const restated = restateConversation(
      undefined,
      [
        { atMs: 200, cents: 5 },
        { atMs: 100, cents: 7 },
      ],
      50,
    );

    expect(restated).toEqual({
      settledBeforeMs: 50,
      settledCents: 0,
      settledEvents: 0,
      recent: [
        [100, 7],
        [200, 5],
      ],
    });
  });

  it('REPLACES a reading still inside the window — never adds to it', () => {
    // An event's charge grows while its request runs; the later reading is
    // the whole charge, not an increment on the earlier one.
    const restated = restateConversation(
      spend({ settledBeforeMs: 50, recent: [[100, 10]] }),
      [{ atMs: 100, cents: 160 }],
      50,
    );

    expect(conversationSpend(restated)).toEqual({ cents: 160, events: 1 });
  });

  it('drops a reading the account no longer reports inside the window', () => {
    const restated = restateConversation(
      spend({ settledBeforeMs: 50, recent: [[100, 10]] }),
      [],
      50,
    );

    expect(conversationSpend(restated)).toEqual({ cents: 0, events: 0 });
  });

  it('settles a reading once the window has moved past it, at its last amount', () => {
    const restated = restateConversation(
      spend({
        settledBeforeMs: 50,
        settledCents: 3,
        settledEvents: 1,
        recent: [
          [100, 10],
          [400, 20],
        ],
      }),
      [{ atMs: 400, cents: 25 }],
      300,
    );

    expect(restated).toEqual({
      settledBeforeMs: 300,
      settledCents: 13,
      settledEvents: 2,
      recent: [[400, 25]],
    });
  });

  it('never reads back an event older than what has already settled', () => {
    // A wider window than the last poll's — a launch, or another conversation
    // being priced for the first time — re-delivers events this conversation
    // has already settled; counting them again is the double count.
    const restated = restateConversation(
      spend({ settledBeforeMs: 300, settledCents: 13, settledEvents: 2 }),
      [
        { atMs: 100, cents: 10 },
        { atMs: 400, cents: 25 },
      ],
      0,
    );

    expect(restated.settledBeforeMs).toBe(300);
    expect(conversationSpend(restated)).toEqual({ cents: 38, events: 3 });
  });
});

describe('readSpendLedger / writeSpendLedger', () => {
  it('round-trips a ledger', () => {
    const ledger = new Map([
      ['b', spend({ settledCents: 1, recent: [[5, 2]] })],
      ['a', spend()],
    ]);

    expect(readSpendLedger(writeSpendLedger(ledger))).toEqual(ledger);
  });

  it('writes equal ledgers as equal text, whatever order they were built in', () => {
    expect(
      writeSpendLedger(
        new Map([
          ['a', spend()],
          ['b', spend()],
        ]),
      ),
    ).toBe(
      writeSpendLedger(
        new Map([
          ['b', spend()],
          ['a', spend()],
        ]),
      ),
    );
  });

  it('reads the previous column’s watermarks, and anything unreadable, as NOTHING priced', () => {
    // A watermark was a bare number. Reading one as priced would keep the
    // undercounted total it stood for; reading it as unpriced restates the
    // conversation from its run's start on the next poll.
    expect(readSpendLedger('{"conv-1":1788358173608}').size).toBe(0);
    expect(readSpendLedger('not json').size).toBe(0);
    expect(readSpendLedger(null).size).toBe(0);
    expect(
      readSpendLedger(
        '{"conv-1":{"settledBeforeMs":0,"settledCents":0,"settledEvents":0,"recent":[["x",1]]}}',
      ).size,
    ).toBe(0);
  });
});
