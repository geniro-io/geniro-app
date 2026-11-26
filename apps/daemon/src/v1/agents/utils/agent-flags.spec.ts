import { describe, expect, it } from 'vitest';

import { AGENT_FLAG_MINUTES_MAX } from '../chat.types';
import { autoFlagCause, minutesLostBetween } from './agent-flags';

describe('minutesLostBetween', () => {
  it('rounds up to whole minutes, never below one', () => {
    expect(minutesLostBetween(1_000, 1_000)).toBe(1);
    expect(minutesLostBetween(0, 60_000)).toBe(1);
    expect(minutesLostBetween(0, 60_001)).toBe(2);
  });

  it('stops at what a flag records', () => {
    expect(minutesLostBetween(0, 24 * 60 * 60_000)).toBe(
      AGENT_FLAG_MINUTES_MAX,
    );
  });
});

describe('autoFlagCause', () => {
  it('names one cause per interruption kind and per tool', () => {
    expect(autoFlagCause.interrupted('crash')).toBe('interrupted:crash');
    expect(autoFlagCause.toolFailure('browser_click')).toBe(
      'tool_failure:browser_click',
    );
    expect(autoFlagCause.toolRefused('browser_click')).toBe(
      'tool_refused:browser_click',
    );
  });
});
