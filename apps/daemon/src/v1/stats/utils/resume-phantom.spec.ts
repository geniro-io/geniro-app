import { describe, expect, it } from 'vitest';

import { UsageEvent } from '../entity/usage-event.entity';
import {
  billedJustBefore,
  correctedTotalCost,
  looksLikeResumePhantom,
  restoredTotalMatch,
} from './resume-phantom';

function row(patch: Partial<UsageEvent>): UsageEvent {
  return Object.assign(new UsageEvent(), {
    numTurns: 0,
    costUsd: 40.676,
    durationMs: 49,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...patch,
  });
}

describe('looksLikeResumePhantom', () => {
  it('takes a zero-turn, zero-token, sub-second turn that cost something', () => {
    expect(looksLikeResumePhantom(row({}))).toBe(true);
  });

  it('leaves a turn that took a second, did work, or cost nothing', () => {
    expect(looksLikeResumePhantom(row({ durationMs: 1_000 }))).toBe(false);
    expect(looksLikeResumePhantom(row({ cacheReadTokens: 12 }))).toBe(false);
    expect(looksLikeResumePhantom(row({ numTurns: 1 }))).toBe(false);
    expect(looksLikeResumePhantom(row({ costUsd: 0 }))).toBe(false);
  });
});

describe('restoredTotalMatch', () => {
  const totals = [17.4528626, 30.753244199999997, 32.1463412];

  it('names a recorded total matched exactly', () => {
    expect(restoredTotalMatch(30.753244199999997, totals)).toBe('total');
  });

  it('names a later total less an earlier one a gap', () => {
    expect(restoredTotalMatch(30.753244199999997 - 17.4528626, totals)).toBe(
      'gap',
    );
  });

  it('matches neither an earlier total less a later one nor a near miss', () => {
    expect(restoredTotalMatch(17.4528626 - 30.753244199999997, totals)).toBe(
      null,
    );
    expect(restoredTotalMatch(30.7532, totals)).toBe(null);
  });
});

describe('billedJustBefore', () => {
  it('holds when the newest turns before the row add up to the amount', () => {
    expect(billedJustBefore(5.1, [3.7, 1.4, 9])).toBe(true);
  });

  it('fails when no run of the newest turns does', () => {
    expect(billedJustBefore(5.1, [3.7, 1.5, 9])).toBe(false);
    expect(billedJustBefore(5.1, [1.4, 3.6])).toBe(false);
    expect(billedJustBefore(5.1, [])).toBe(false);
  });
});

describe('correctedTotalCost', () => {
  it('takes the turns just before it off the total', () => {
    expect(correctedTotalCost(38.567, [21.544, 0])).toBeCloseTo(17.023, 9);
    expect(correctedTotalCost(40.676, [40.676])).toBe(0);
  });

  it('lets a whole conversation through when its steps overshoot only by float error', () => {
    // These steps sum to 22.898622000000003.
    expect(
      correctedTotalCost(
        22.898622,
        [
          1.6244429999999994, 7.253806000000001, 7.392614999999999,
          5.6040790000000005, 1.023679,
        ],
      ),
    ).toBe(0);
  });

  it('stops at a turn that would overshoot — an earlier conversation’s', () => {
    expect(correctedTotalCost(5, [3, 20, 1])).toBe(2);
  });

  it('leaves a total nothing was billed before in its own conversation', () => {
    expect(correctedTotalCost(9.248, [])).toBeNull();
    expect(correctedTotalCost(9.248, [0])).toBeNull();
    expect(correctedTotalCost(5, [20])).toBeNull();
  });
});
