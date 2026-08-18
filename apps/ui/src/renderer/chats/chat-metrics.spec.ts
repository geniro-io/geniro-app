import { describe, expect, it } from 'vitest';

import { formatTimeUntil } from './chat-metrics';

const NOW = Date.parse('2026-08-18T07:10:00.000Z');
const inMinutes = (minutes: number): string =>
  new Date(NOW + minutes * 60_000).toISOString();

describe('formatTimeUntil', () => {
  it('counts a plan window down in two units, largest first', () => {
    expect(formatTimeUntil(inMinutes(12), NOW)).toBe('12m');
    expect(formatTimeUntil(inMinutes(3 * 60 + 50), NOW)).toBe('3h 50m');
    // The DAY tier the app's other two duration formatters deliberately lack.
    // A seven-day window is routinely days out, and nobody reads `115h 20m` as
    // "next Sunday".
    expect(formatTimeUntil(inMinutes(4 * 24 * 60 + 20 * 60), NOW)).toBe(
      '4d 20h',
    );
  });

  it('answers null for a moment that has already passed', () => {
    // The window refilled since the reading was taken, so the PERCENTAGE beside
    // it is the stale figure — and a countdown reading `0m` under it claims a
    // precision the reading does not have. The next open asks again.
    expect(formatTimeUntil(inMinutes(-5), NOW)).toBeNull();
    expect(formatTimeUntil(inMinutes(0), NOW)).toBeNull();
  });

  it('answers null when the CLI named no moment, or an unparseable one', () => {
    expect(formatTimeUntil(null, NOW)).toBeNull();
    expect(formatTimeUntil('whenever', NOW)).toBeNull();
  });
});
