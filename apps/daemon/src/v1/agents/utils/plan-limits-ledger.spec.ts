import { describe, expect, it } from 'vitest';

import type { PlanLimitsWire } from '../chat.types';
import {
  accountKeyOf,
  LEDGER_MAX_AGE_MS,
  pickBetter,
  PlanLimitsLedger,
  REAL_READING_PREFERRED_MS,
} from './plan-limits-ledger';

function plan(percent: number, estimated: boolean): PlanLimitsWire {
  return {
    plan: 'team',
    windows: [
      { key: 'session', label: 'Current session', percent, resetsAt: null },
    ],
    estimated,
  };
}

const KEY = accountKeyOf('claude', null);

describe('PlanLimitsLedger', () => {
  it("serves one chat's reading to another chat on the same account", () => {
    const ledger = new PlanLimitsLedger();
    ledger.settle(KEY, { plan: plan(96, false), takenAt: 1_000 }, 1_000);

    // The second chat has no reading of its own (its agent was closed).
    expect(ledger.settle(KEY, null, 2_000)?.plan.windows[0]?.percent).toBe(96);
  });

  it('keeps a real reading over a newer ESTIMATED one — the reported 45% vs 96%', () => {
    const ledger = new PlanLimitsLedger();
    ledger.settle(KEY, { plan: plan(96, false), takenAt: 1_000 }, 1_000);

    const best = ledger.settle(
      KEY,
      { plan: plan(45, true), takenAt: 61_000 },
      61_000,
    );
    expect(best?.plan.windows[0]?.percent).toBe(96);
    expect(best?.plan.estimated).toBe(false);
  });

  it('lets an estimate win once the real reading is old enough to be the worse answer', () => {
    const real = { plan: plan(96, false), takenAt: 0 };
    const estimate = {
      plan: plan(20, true),
      takenAt: REAL_READING_PREFERRED_MS + 1,
    };
    expect(pickBetter(real, estimate)).toBe(estimate);
  });

  it('takes the newer of two readings of the same kind', () => {
    const ledger = new PlanLimitsLedger();
    ledger.settle(KEY, { plan: plan(50, false), takenAt: 1_000 }, 1_000);
    expect(
      ledger.settle(KEY, { plan: plan(60, false), takenAt: 2_000 }, 2_000)?.plan
        .windows[0]?.percent,
    ).toBe(60);
    // And an OLDER real reading arriving late does not replace it.
    expect(
      ledger.settle(KEY, { plan: plan(40, false), takenAt: 1_500 }, 3_000)?.plan
        .windows[0]?.percent,
    ).toBe(60);
  });

  it('keeps two accounts apart — a profile is its own account', () => {
    const ledger = new PlanLimitsLedger();
    const work = accountKeyOf('claude', '/Users/me/.claude-work');
    ledger.settle(work, { plan: plan(90, false), takenAt: 1_000 }, 1_000);

    expect(ledger.settle(KEY, null, 2_000)).toBeNull();
    expect(ledger.settle(accountKeyOf('codex', null), null, 2_000)).toBeNull();
  });

  it('stops serving a reading past its age bound', () => {
    const ledger = new PlanLimitsLedger();
    ledger.settle(KEY, { plan: plan(90, false), takenAt: 0 }, 0);
    expect(ledger.settle(KEY, null, LEDGER_MAX_AGE_MS + 1)).toBeNull();
  });

  it('forgets an account that answered it has no plan windows', () => {
    const ledger = new PlanLimitsLedger();
    ledger.settle(KEY, { plan: plan(90, false), takenAt: 0 }, 0);
    ledger.forget(KEY);
    expect(ledger.settle(KEY, null, 1)).toBeNull();
  });

  it('shares nothing for a run that names no agent', () => {
    const ledger = new PlanLimitsLedger();
    const offered = { plan: plan(10, false), takenAt: 0 };
    expect(ledger.settle(null, offered, 0)).toBe(offered);
    expect(ledger.settle(null, null, 1)).toBeNull();
  });
});
