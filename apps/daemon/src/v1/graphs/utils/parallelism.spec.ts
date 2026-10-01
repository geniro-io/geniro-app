import { describe, expect, it } from 'vitest';

import { parallelAgentsFor } from './parallelism';

const GB = 1024 ** 3;

describe('parallelAgentsFor', () => {
  it('widens with the machine, on the session-ceiling curve', () => {
    expect(parallelAgentsFor(64 * GB)).toBe(8);
    expect(parallelAgentsFor(128 * GB)).toBe(16);
  });

  it('never runs narrower than the old flat four', () => {
    expect(parallelAgentsFor(32 * GB)).toBe(4);
    expect(parallelAgentsFor(16 * GB)).toBe(4);
    expect(parallelAgentsFor(0)).toBe(4);
  });

  it('stops at the session ceiling’s cap on a huge machine', () => {
    expect(parallelAgentsFor(1024 * GB)).toBe(16);
  });
});
