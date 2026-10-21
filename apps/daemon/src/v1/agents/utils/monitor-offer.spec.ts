import { describe, expect, it } from 'vitest';

import { offersMonitorTools } from './monitor-offer';

describe('offersMonitorTools', () => {
  const gated = { hostToolCallUngatedReason: null };
  const ungated = { hostToolCallUngatedReason: 'calls run unasked in ask' };

  it('offers them wherever a geniro tool call is put to the user first', () => {
    for (const mode of ['ask', 'acceptEdits', 'plan', 'auto', undefined]) {
      expect(offersMonitorTools(gated, mode)).toBe(true);
    }
  });

  it('withholds them from a CLI that would run them unasked, except under auto', () => {
    expect(offersMonitorTools(ungated, 'ask')).toBe(false);
    expect(offersMonitorTools(ungated, 'plan')).toBe(false);
    expect(offersMonitorTools(ungated, undefined)).toBe(false);
    expect(offersMonitorTools(ungated, 'auto')).toBe(true);
  });
});
