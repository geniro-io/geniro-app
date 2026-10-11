import { describe, expect, it } from 'vitest';

import { HOST_COMPARISON_TOOL } from '../chat.types';
import { isHostComparisonCall } from './host-comparison';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostComparisonCall', () => {
  it('matches both CLIs’ spellings of this run’s server', () => {
    expect(
      isHostComparisonCall(SERVER, `mcp__${SERVER}__${HOST_COMPARISON_TOOL}`),
    ).toBe(true);
    expect(
      isHostComparisonCall(
        SERVER,
        `${SERVER}-${HOST_COMPARISON_TOOL}: ${HOST_COMPARISON_TOOL}`,
      ),
    ).toBe(true);
  });

  it('refuses somebody else’s tool of the same name', () => {
    expect(isHostComparisonCall(SERVER, 'mcp__acme__show_comparison')).toBe(
      false,
    );
    expect(
      isHostComparisonCall(null, `mcp__${SERVER}__${HOST_COMPARISON_TOOL}`),
    ).toBe(false);
  });
});
