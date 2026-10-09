import { describe, expect, it } from 'vitest';

import { LineSnapshotWireSchema, MAX_LINE_COUNT } from '../stats.types';

describe('LineSnapshotWireSchema', () => {
  const measured = {
    runId: 'run-a',
    linesAdded: 3,
    linesRemoved: 1,
    partial: false,
  };

  it('accepts a count at the bound', () => {
    expect(
      LineSnapshotWireSchema.safeParse({
        ...measured,
        linesAdded: MAX_LINE_COUNT,
      }).success,
    ).toBe(true);
  });

  it('refuses a count past the bound, so a period’s sums stay exact integers', () => {
    expect(
      LineSnapshotWireSchema.safeParse({
        ...measured,
        linesAdded: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(false);
    expect(
      LineSnapshotWireSchema.safeParse({
        ...measured,
        linesRemoved: MAX_LINE_COUNT + 1,
      }).success,
    ).toBe(false);
  });
});
