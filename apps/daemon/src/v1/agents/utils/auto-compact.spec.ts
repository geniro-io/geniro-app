import { describe, expect, it } from 'vitest';

import {
  autoCompactDue,
  autoCompactNotice,
  contextPercent,
} from './auto-compact';

describe('contextPercent', () => {
  it('is the share of the window the tokens fill', () => {
    expect(contextPercent({ tokens: 150_000, window: 200_000 })).toBe(75);
  });

  it('is null when either figure was never measured', () => {
    expect(contextPercent({ tokens: null, window: 200_000 })).toBeNull();
    expect(contextPercent({ tokens: 150_000, window: null })).toBeNull();
    expect(contextPercent({ tokens: 150_000, window: 0 })).toBeNull();
    expect(contextPercent({ tokens: 0, window: 200_000 })).toBeNull();
  });
});

describe('autoCompactDue', () => {
  it('fires at the threshold itself, not only past it', () => {
    expect(autoCompactDue(80, { tokens: 160_000, window: 200_000 })).toBe(true);
    expect(autoCompactDue(80, { tokens: 159_999, window: 200_000 })).toBe(
      false,
    );
  });

  it('never fires with no threshold set', () => {
    expect(autoCompactDue(null, { tokens: 199_000, window: 200_000 })).toBe(
      false,
    );
  });

  it('never fires on a reading nothing measured', () => {
    expect(autoCompactDue(50, { tokens: 190_000, window: null })).toBe(false);
  });

  it('holds off after a compaction that left the conversation over the threshold, until it regrows by a tenth of the window', () => {
    // A 10% threshold under a 30k baseline: every turn is "over", and only the
    // regrowth rule stops a compaction after each one.
    const window = 200_000;
    expect(autoCompactDue(10, { tokens: 40_000, window }, 30_000)).toBe(false);
    expect(autoCompactDue(10, { tokens: 49_999, window }, 30_000)).toBe(false);
    expect(autoCompactDue(10, { tokens: 50_000, window }, 30_000)).toBe(true);
  });

  it('ignores the baseline when the reading is under the threshold', () => {
    expect(autoCompactDue(80, { tokens: 150_000, window: 200_000 }, 0)).toBe(
      false,
    );
  });
});

describe('autoCompactNotice', () => {
  it('names the threshold and the reading that crossed it', () => {
    expect(autoCompactNotice(80, { tokens: 164_200, window: 200_000 })).toBe(
      'Context reached the 80% auto-compact threshold (82% — 164k of 200k tokens) — compacting the conversation.',
    );
  });
});
