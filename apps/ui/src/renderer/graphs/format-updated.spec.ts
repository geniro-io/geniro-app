import { describe, expect, it } from 'vitest';

import { formatUpdated } from './format-updated';

describe('formatUpdated', () => {
  const now = new Date('2026-07-05T12:00:00.000Z').getTime();
  const ago = (ms: number): string => new Date(now - ms).toISOString();

  it('says "just now" under 45 seconds', () => {
    expect(formatUpdated(ago(10_000), now)).toBe('just now');
  });

  it('renders whole minutes', () => {
    expect(formatUpdated(ago(5 * 60_000), now)).toBe('5m ago');
  });

  it('renders whole hours', () => {
    expect(formatUpdated(ago(3 * 3_600_000), now)).toBe('3h ago');
  });

  it('renders whole days', () => {
    expect(formatUpdated(ago(2 * 86_400_000), now)).toBe('2d ago');
  });

  it('falls back to a locale date past a week', () => {
    // The real pin for the >7d branch: the label is a formatted date, never a
    // relative "…ago" string. Asserting the exact locale string would couple
    // the test to the runner's locale, so we assert the branch behavior.
    const result = formatUpdated(ago(30 * 86_400_000), now);
    expect(result).not.toMatch(/ago$/);
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns an empty string for an unparseable timestamp', () => {
    expect(formatUpdated('not-a-date', now)).toBe('');
  });
});
