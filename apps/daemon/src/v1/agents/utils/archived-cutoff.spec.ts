import { describe, expect, it } from 'vitest';

import { archivedCutoff } from './archived-cutoff';

const NOW = new Date(Date.UTC(2026, 10, 9, 12));

describe('archivedCutoff', () => {
  it('lies whole 24h days before the moment asked', () => {
    expect(archivedCutoff(30, NOW)).toEqual(
      new Date(Date.UTC(2026, 9, 10, 12)),
    );
  });

  it('is the moment asked for zero days', () => {
    expect(archivedCutoff(0, NOW)).toEqual(NOW);
  });
});
