import { describe, expect, it } from 'vitest';

import { effortListed } from './effort-listed';

function adapter(effortsAreExhaustive: boolean) {
  return {
    listEfforts: () => [{ id: 'low', label: 'Low' }],
    getConfig: () => ({ effortsAreExhaustive }),
  } as unknown as Parameters<typeof effortListed>[0];
}

describe('effortListed', () => {
  it('answers from a complete list only', () => {
    expect(effortListed(adapter(true), 'low')).toBe(true);
    expect(effortListed(adapter(true), 'extreme')).toBe(false);
    expect(effortListed(adapter(false), 'extreme')).toBeNull();
  });
});
