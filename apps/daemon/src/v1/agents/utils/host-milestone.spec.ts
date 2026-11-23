import { describe, expect, it } from 'vitest';

import { HOST_MILESTONE_TOOL } from '../chat.types';
import { isHostMilestoneCall } from './host-milestone';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostMilestoneCall', () => {
  it("matches claude's and cursor's spellings of the per-run server's tool", () => {
    expect(
      isHostMilestoneCall(SERVER, `mcp__${SERVER}__${HOST_MILESTONE_TOOL}`),
    ).toBe(true);
    expect(
      isHostMilestoneCall(
        SERVER,
        `${SERVER}-${HOST_MILESTONE_TOOL}: ${HOST_MILESTONE_TOOL}`,
      ),
    ).toBe(true);
  });

  it('refuses a bare name, another server and no server', () => {
    expect(isHostMilestoneCall(SERVER, HOST_MILESTONE_TOOL)).toBe(false);
    expect(
      isHostMilestoneCall(SERVER, `mcp__acme__${HOST_MILESTONE_TOOL}`),
    ).toBe(false);
    expect(
      isHostMilestoneCall(null, `mcp__${SERVER}__${HOST_MILESTONE_TOOL}`),
    ).toBe(false);
  });
});
