// The short-date fallback renders in the LOCAL zone; pin it so the expected
// strings hold on any machine. Must be set before the first Date formatting.
process.env.TZ = 'UTC';

import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from './relative-time';

const NOW = Date.parse('2026-07-18T12:00:00Z');

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('formatRelativeTime', () => {
  it('labels under a minute as "just now"', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('just now');
    expect(formatRelativeTime(ago(59_000), NOW)).toBe('just now');
  });

  it('uses minutes, hours, then days', () => {
    expect(formatRelativeTime(ago(60_000), NOW)).toBe('1m');
    expect(formatRelativeTime(ago(59 * 60_000), NOW)).toBe('59m');
    expect(formatRelativeTime(ago(60 * 60_000), NOW)).toBe('1h');
    expect(formatRelativeTime(ago(23 * 3_600_000), NOW)).toBe('23h');
    expect(formatRelativeTime(ago(24 * 3_600_000), NOW)).toBe('1d');
    expect(formatRelativeTime(ago(6 * 86_400_000), NOW)).toBe('6d');
  });

  it('falls back to a short date at a week, adding the year across years', () => {
    expect(formatRelativeTime('2026-07-01T12:00:00Z', NOW)).toBe('Jul 1');
    expect(formatRelativeTime('2025-12-31T12:00:00Z', NOW)).toBe(
      'Dec 31, 2025',
    );
  });

  it('returns an empty label for an unparseable timestamp', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });
});
