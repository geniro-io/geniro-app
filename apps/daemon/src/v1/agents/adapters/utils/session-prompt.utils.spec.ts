import { describe, expect, it } from 'vitest';

import { sessionResumabilityOf } from './session-prompt.utils';

describe('sessionResumabilityOf', () => {
  it('reads a session with no saved prompt as unsaved, whatever was asked', () => {
    expect(sessionResumabilityOf([], null)).toBe('unsaved');
    expect(sessionResumabilityOf([], 'brief')).toBe('unsaved');
  });

  it('reads any saved prompt as resumable when none was asked', () => {
    expect(sessionResumabilityOf(['earlier'], null)).toBe('resumable');
  });

  it('finds the asked prompt inside a wrapped, re-flowed saved message', () => {
    expect(
      sessionResumabilityOf(
        ['earlier', '<host>rules</host>\n\nNew task:\n  reply   ZEBRA-1'],
        'New task: reply ZEBRA-1',
      ),
    ).toBe('resumable');
  });

  it('reads earlier prompts without the asked one as prompt-missing', () => {
    expect(
      sessionResumabilityOf(['Reply READY'], 'New task: reply ZEBRA-1'),
    ).toBe('prompt-missing');
  });
});
