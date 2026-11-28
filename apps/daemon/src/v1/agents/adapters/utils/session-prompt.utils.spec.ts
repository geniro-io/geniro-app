import { describe, expect, it } from 'vitest';

import { sessionResumabilityOf } from './session-prompt.utils';

describe('sessionResumabilityOf', () => {
  it('reads a session with no saved prompt as unsaved, whatever was asked', () => {
    expect(sessionResumabilityOf([], [])).toBe('unsaved');
    expect(sessionResumabilityOf([], ['brief'])).toBe('unsaved');
  });

  it('reads any saved prompt as resumable when none was asked', () => {
    expect(sessionResumabilityOf(['earlier'], [])).toBe('resumable');
  });

  it('finds the asked prompt inside a wrapped, re-flowed saved message', () => {
    expect(
      sessionResumabilityOf(
        ['Reply READY', '<host>rules</host>\n\nNew task:\n  reply   ZEBRA-1'],
        ['Reply READY', 'New task: reply ZEBRA-1'],
      ),
    ).toBe('resumable');
  });

  it('reads earlier prompts without the asked one as prompt-missing', () => {
    expect(
      sessionResumabilityOf(
        ['Reply READY'],
        ['Reply READY', 'New task: reply ZEBRA-1'],
      ),
    ).toBe('prompt-missing');
  });

  it('does not take the asked prompt from a context message or the earlier brief that carries it', () => {
    const saved = [
      '<user_info>tools: Check again before you answer</user_info>',
      '<user_query>Reply READY\n\n<host-context>Check again</host-context></user_query>',
    ];
    expect(sessionResumabilityOf(saved, ['Reply READY', 'Check again'])).toBe(
      'prompt-missing',
    );
    expect(
      sessionResumabilityOf(
        [...saved, '<user_query>Check again</user_query>'],
        ['Reply READY', 'Check again'],
      ),
    ).toBe('resumable');
  });

  it('needs a brief repeated on the thread saved once more for the repeat', () => {
    const briefs = ['Run the checks', 'Run the checks'];
    expect(sessionResumabilityOf(['Run the checks'], briefs)).toBe(
      'prompt-missing',
    );
    expect(
      sessionResumabilityOf(['Run the checks', 'Run the checks'], briefs),
    ).toBe('resumable');
  });

  it('passes over an earlier brief its session never saved', () => {
    const briefs = ['Reply READY', 'reply ZEBRA-6002', 'reply ZEBRA-7002'];
    expect(
      sessionResumabilityOf(
        ['Reply READY', '[geniro] The app was quit', 'reply ZEBRA-7002'],
        briefs,
      ),
    ).toBe('resumable');
    expect(
      sessionResumabilityOf(
        ['Reply READY', '[geniro] The app was quit'],
        briefs,
      ),
    ).toBe('prompt-missing');
  });

  it('matches the asked prompt as whole words only', () => {
    expect(
      sessionResumabilityOf(
        ['Reply READY', 'a good token'],
        ['Reply READY', 'go'],
      ),
    ).toBe('prompt-missing');
    expect(
      sessionResumabilityOf(['Reply READY', 'ok, go.'], ['Reply READY', 'go']),
    ).toBe('resumable');
  });
});
