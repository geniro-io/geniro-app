import { describe, expect, it } from 'vitest';

import {
  cursorUsagePageLength,
  cursorUsageRequestBody,
  cursorUsageTotalCount,
  readCursorUsageEvents,
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
const ASKED = new Set([ID, 'other']);

describe('readCursorUsageEvents', () => {
  it('reads each event as charged, keyed by its own date and model', () => {
    expect(
      readCursorUsageEvents({ usageEventsDisplay: [event()] }, ASKED),
    ).toEqual([
      {
        conversationId: ID,
        key: '1788171101936|gemini-3.1-pro',
        atMs: 1788171101936,
        model: 'gemini-3.1-pro',
        cents: 11.058271999999999,
      },
    ]);
  });

  it('keeps two conversations apart, and drops one nobody asked about', () => {
    const events = readCursorUsageEvents(
      {
        usageEventsDisplay: [
          event(),
          event({ conversationId: 'other' }),
          event({ conversationId: 'stranger' }),
        ],
      },
      ASKED,
    );
    expect(events.map((one) => one.conversationId)).toEqual([ID, 'other']);
  });

  it('DROPS an event with no conversation id rather than pooling it', () => {
    // The one failure this whole approach exists to avoid is attributing a
    // charge to the wrong thread, so an unattributable event costs its own
    // cents and never somebody else's total.
    expect(
      readCursorUsageEvents(
        { usageEventsDisplay: [event({ conversationId: '' })] },
        new Set(['']),
      ),
    ).toEqual([]);
  });

  it('DROPS an event with no readable timestamp, which no later poll could find again', () => {
    expect(
      readCursorUsageEvents(
        {
          usageEventsDisplay: [
            event({ timestamp: undefined }),
            event({ timestamp: 'nope' }),
            event({ timestamp: '' }),
          ],
        },
        ASKED,
      ),
    ).toEqual([]);
  });

  it('keeps an event the account was not charged for, at zero', () => {
    // So a charge the vendor waives after first listing it REPLACES the figure
    // an earlier poll held under its key, rather than leaving it standing.
    expect(
      readCursorUsageEvents(
        { usageEventsDisplay: [event({ isChargeable: false })] },
        ASKED,
      ).map((one) => one.cents),
    ).toEqual([0]);
  });

  it('answers empty on a reply it cannot read', () => {
    expect(readCursorUsageEvents(null, ASKED)).toEqual([]);
    expect(
      readCursorUsageEvents({ usageEventsDisplay: 'nope' }, ASKED),
    ).toEqual([]);
    expect(readCursorUsageEvents({}, ASKED)).toEqual([]);
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
  it('counts the page as the wire sent it, before any reading', () => {
    // The paging loop terminates on this rather than on what the reader kept:
    // the reader drops every other conversation's events, so its count never
    // sums towards `cursorUsageTotalCount` and the loop would walk every page
    // it is allowed without ever reaching it.
    expect(
      cursorUsagePageLength({ usageEventsDisplay: [event(), event()] }),
    ).toBe(2);
    // …including events the reader will drop.
    expect(
      cursorUsagePageLength({
        usageEventsDisplay: [event({ conversationId: '' })],
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
