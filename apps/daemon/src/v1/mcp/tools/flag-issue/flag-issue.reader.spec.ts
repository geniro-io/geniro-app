import { describe, expect, it } from 'vitest';

import { readFlagIssue } from './flag-issue.reader';

describe('readFlagIssue', () => {
  const base = {
    cost: 'work',
    category: 'geniro_tool',
    summary: 'The monitor never woke me',
    minutesLost: 30,
  };

  it('reads a work flag and an optional detail', () => {
    expect(readFlagIssue({ ...base, detail: ' polled by hand ' })).toEqual({
      cost: 'work',
      category: 'geniro_tool',
      summary: 'The monitor never woke me',
      detail: 'polled by hand',
      minutesLost: 30,
    });
  });

  it('reads a disagreement without minutes, and a null the model sent for detail as absent', () => {
    expect(
      readFlagIssue({
        cost: 'disagreement',
        category: 'user_instructions',
        summary: 'User wanted a draft PR',
        detail: null,
      }),
    ).toEqual({
      cost: 'disagreement',
      category: 'user_instructions',
      summary: 'User wanted a draft PR',
      detail: null,
      minutesLost: null,
    });
  });

  it('refuses a work flag that does not say what it cost', () => {
    const { minutesLost: _omitted, ...withoutMinutes } = base;
    expect(readFlagIssue(withoutMinutes)).toEqual({
      error: expect.stringMatching(/^MINUTES_REQUIRED:/) as string,
    });
  });

  it('refuses a summary or detail over its cap rather than cutting it', () => {
    expect(readFlagIssue({ ...base, summary: 'x'.repeat(301) })).toEqual({
      error: 'TOO_LONG: summary is over 300 characters',
    });
    expect(readFlagIssue({ ...base, detail: 'x'.repeat(2001) })).toEqual({
      error: 'TOO_LONG: detail is over 2000 characters',
    });
  });

  it('refuses control characters', () => {
    expect(readFlagIssue({ ...base, summary: 'bad\u0007bell' })).toEqual({
      error: expect.stringMatching(/^CONTROL_CHARACTERS:/) as string,
    });
  });

  it('refuses an unknown category, minutes out of range and a stray field', () => {
    expect('error' in readFlagIssue({ ...base, category: 'ui' })).toBe(true);
    expect('error' in readFlagIssue({ ...base, minutesLost: 601 })).toBe(true);
    expect('error' in readFlagIssue({ ...base, runId: 'other' })).toBe(true);
  });
});
