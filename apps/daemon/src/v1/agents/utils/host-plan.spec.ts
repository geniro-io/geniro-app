import { describe, expect, it } from 'vitest';

import { HOST_PLAN_TOOL } from '../chat.types';
import { isHostPlanCall } from './host-plan';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostPlanCall', () => {
  it('matches both CLIs’ spellings of this run’s server', () => {
    expect(isHostPlanCall(SERVER, `mcp__${SERVER}__${HOST_PLAN_TOOL}`)).toBe(
      true,
    );
    expect(
      isHostPlanCall(SERVER, `${SERVER}-${HOST_PLAN_TOOL}: ${HOST_PLAN_TOOL}`),
    ).toBe(true);
  });

  it('refuses somebody else’s tool of the same name', () => {
    expect(isHostPlanCall(SERVER, 'mcp__acme__propose_plan')).toBe(false);
    expect(isHostPlanCall(null, `mcp__${SERVER}__${HOST_PLAN_TOOL}`)).toBe(
      false,
    );
  });
});
