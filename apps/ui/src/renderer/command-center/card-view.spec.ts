import { describe, expect, it } from 'vitest';

import { IDLE_AFTER_DAYS, idleDaysOf } from './card-view';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const DAY = 24 * 60 * 60_000;

describe('idleDaysOf', () => {
  it('says nothing for a thread that moved within the last few days', () => {
    expect(
      idleDaysOf(
        new Date(NOW - (IDLE_AFTER_DAYS - 0.5) * DAY).toISOString(),
        NOW,
      ),
    ).toBeNull();
  });

  it('counts the whole days once a thread has sat still long enough', () => {
    expect(
      idleDaysOf(new Date(NOW - IDLE_AFTER_DAYS * DAY).toISOString(), NOW),
    ).toBe(IDLE_AFTER_DAYS);
    expect(idleDaysOf(new Date(NOW - 14.7 * DAY).toISOString(), NOW)).toBe(14);
  });
});
