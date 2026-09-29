import { describe, expect, it } from 'vitest';

import {
  codexPlanLimitsRequestLine,
  readCodexPlanLimits,
  readCodexPlanLimitsReply,
} from './codex-plan-limits.utils';

/** Transcribed from a live `account/rateLimits/read` (codex 0.157.1, Plus). */
const RESULT = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1790531464 },
    secondary: {
      usedPercent: 0,
      windowDurationMins: 10080,
      resetsAt: 1791118264,
    },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    planType: 'plus',
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {},
};

describe('readCodexPlanLimits', () => {
  it('reads the short and weekly windows with their resets', () => {
    expect(readCodexPlanLimits(RESULT)).toEqual({
      plan: 'plus',
      windows: [
        {
          key: 'primary',
          label: '5-hour limit',
          percent: 1,
          resetsAt: new Date(1790531464 * 1000).toISOString(),
        },
        {
          key: 'secondary',
          label: 'Weekly limit',
          percent: 0,
          resetsAt: new Date(1791118264 * 1000).toISOString(),
        },
      ],
    });
  });

  it('answers null when the account reports no window at all', () => {
    expect(
      readCodexPlanLimits({ rateLimits: { primary: null, secondary: null } }),
    ).toBeNull();
  });
});

describe('the live-process ask', () => {
  it('reads only the reply to its own request', () => {
    const line = JSON.parse(codexPlanLimitsRequestLine('geniro-limits-1')) as {
      id: string;
      method: string;
    };
    expect(line).toMatchObject({
      id: 'geniro-limits-1',
      method: 'account/rateLimits/read',
    });
    // Every other line the process prints is offered to the reader too.
    expect(
      readCodexPlanLimitsReply({ id: 7, result: RESULT }, 'geniro-limits-1'),
    ).toBeNull();
    expect(
      readCodexPlanLimitsReply(
        { method: 'turn/started', params: {} },
        'geniro-limits-1',
      ),
    ).toBeNull();
    expect(
      readCodexPlanLimitsReply(
        { id: 'geniro-limits-1', result: RESULT },
        'geniro-limits-1',
      )?.plan,
    ).toBe('plus');
  });
});
