import { describe, expect, it } from 'vitest';

import { archivedPeriodWindow } from './archived-periods';

const NOW = new Date(Date.UTC(2026, 10, 9, 12));

describe('archivedPeriodWindow', () => {
  it('names the last N days, up to the moment asked', () => {
    expect(archivedPeriodWindow(30, NOW)).toEqual({
      from: new Date(Date.UTC(2026, 9, 10, 12)),
      to: NOW,
    });
  });

  it('has no lower bound for every archived chat', () => {
    expect(archivedPeriodWindow(null, NOW)).toEqual({ from: null, to: NOW });
  });
});
