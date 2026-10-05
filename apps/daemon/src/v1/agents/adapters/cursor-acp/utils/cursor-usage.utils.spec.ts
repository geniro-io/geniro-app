import { describe, expect, it } from 'vitest';

import {
  cursorUsageEvents,
  cursorUsagePageLength,
  cursorUsageRequestBody,
  cursorUsageTotalCount,
  mergeCursorUsageEvents,
} from './cursor-usage.utils';

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

const ID = '7d781e85-8ed6-4771-8d81-b2e132fd0c2d';

describe('cursorUsageEvents', () => {
  it('reads every charged event per conversation, at its current amount', () => {
    const events = cursorUsageEvents({
      usageEventsDisplay: [
        event(),
        event({ chargedCents: 1, timestamp: '1788171101999' }),
      ],
    });
    expect(events.get(ID)).toEqual([
      { atMs: 1788171101936, cents: 11.058271999999999 },
      { atMs: 1788171101999, cents: 1 },
    ]);
  });

  it('keeps two conversations apart', () => {
    const events = cursorUsageEvents({
      usageEventsDisplay: [event(), event({ conversationId: 'other' })],
    });
    expect([...events.keys()].sort()).toEqual([ID, 'other']);
  });

  it('DROPS an event with no conversation id rather than pooling it', () => {
    // The one failure this whole approach exists to avoid is attributing a
    // charge to the wrong thread, so an unattributable event costs its own
    // cents and never somebody else's total.
    const events = cursorUsageEvents({
      usageEventsDisplay: [event({ conversationId: '' }), event()],
    });
    expect(events.size).toBe(1);
    expect(events.get(ID)).toHaveLength(1);
  });

  it('DROPS an event it cannot place in time', () => {
    // The poll tells one event from the next by its timestamp; one with none
    // could never be replaced by its next reading, and would be counted again
    // on every poll.
    expect(
      cursorUsageEvents({
        usageEventsDisplay: [
          event({ timestamp: undefined }),
          event({ timestamp: 'nope' }),
          event({ timestamp: '' }),
        ],
      }).size,
    ).toBe(0);
  });

  it('skips an event the account was not charged for', () => {
    const events = cursorUsageEvents({
      usageEventsDisplay: [event({ isChargeable: false })],
    });
    expect(events.size).toBe(0);
  });

  it('answers empty on a reply it cannot read', () => {
    expect(cursorUsageEvents(null).size).toBe(0);
    expect(cursorUsageEvents({ usageEventsDisplay: 'nope' }).size).toBe(0);
    expect(cursorUsageEvents({}).size).toBe(0);
  });
});

describe('mergeCursorUsageEvents', () => {
  it('appends a later page to the running collection', () => {
    const into = cursorUsageEvents({ usageEventsDisplay: [event()] });
    mergeCursorUsageEvents(
      into,
      cursorUsageEvents({
        usageEventsDisplay: [event({ chargedCents: 5, timestamp: '9' })],
      }),
    );
    expect(into.get(ID)).toEqual([
      { atMs: 1788171101936, cents: 11.058271999999999 },
      { atMs: 9, cents: 5 },
    ]);
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

describe('cursorUsagePageLength', () => {
  it('counts the page as the wire sent it, before any event is dropped', () => {
    // The paging loop terminates on this rather than on what the reader kept:
    // the reader drops uncharged and unattributable events, so its count does
    // not sum towards `cursorUsageTotalCount` and the loop would walk every
    // page it is allowed without ever reaching it.
    expect(
      cursorUsagePageLength({ usageEventsDisplay: [event(), event()] }),
    ).toBe(2);
    // …including events the reader will drop.
    expect(
      cursorUsagePageLength({
        usageEventsDisplay: [event({ isChargeable: false })],
      }),
    ).toBe(1);
  });

  it('answers 0 for every shape that is not a page', () => {
    expect(cursorUsagePageLength(null)).toBe(0);
    expect(cursorUsagePageLength({})).toBe(0);
    expect(cursorUsagePageLength({ usageEventsDisplay: 'nope' })).toBe(0);
    expect(cursorUsagePageLength('not an object')).toBe(0);
  });
});
