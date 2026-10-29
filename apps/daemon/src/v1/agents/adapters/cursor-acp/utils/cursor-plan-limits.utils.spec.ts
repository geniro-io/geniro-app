import { describe, expect, it } from 'vitest';

import { NO_PLAN_LIMITS } from '../../adapter.types';
import { readCursorPlanLimits } from './cursor-plan-limits.utils';

describe('readCursorPlanLimits', () => {
  it('works the included figure out of spend and limit when no percentage is sent', () => {
    expect(
      readCursorPlanLimits(
        { planUsage: { includedSpend: 1500, limit: 2000 } },
        null,
      ),
    ).toEqual({
      plan: null,
      estimated: false,
      windows: [
        { key: 'included', label: 'Included', percent: 75, resetsAt: null },
        { key: 'auto', label: 'Auto', percent: 0, resetsAt: null },
        { key: 'api', label: 'API', percent: 0, resetsAt: null },
      ],
    });
  });

  it('dates the windows from the plan when the period names no end', () => {
    const limits = readCursorPlanLimits(
      { billingCycleEnd: '0', planUsage: { totalPercentUsed: 120 } },
      { planInfo: { planName: ' Pro ', billingCycleEnd: '1793491200000' } },
    );

    expect(limits).toMatchObject({
      plan: 'Pro',
      windows: [
        {
          key: 'included',
          percent: 100,
          resetsAt: new Date(1793491200000).toISOString(),
        },
        {},
        {},
      ],
    });
  });

  it('tells an account with no plan usage from a reply that is not one', () => {
    expect(readCursorPlanLimits({ displayThreshold: 100 }, null)).toBe(
      NO_PLAN_LIMITS,
    );
    expect(readCursorPlanLimits('nope', null)).toBeNull();
  });
});
