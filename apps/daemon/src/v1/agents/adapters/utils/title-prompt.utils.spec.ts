import { describe, expect, it } from 'vitest';

import {
  readTitleAnswer,
  TITLE_EXCERPT_MAX_CHARS,
  TITLE_MAX_WORDS,
  titlePrompt,
} from './title-prompt.utils';

describe('titlePrompt', () => {
  it('quotes both halves of the exchange under their own headings', () => {
    const prompt = titlePrompt({
      opening: '/geniro:implement https://tracker/x',
      reply: 'I will start by fetching the task.',
      latest: null,
      configDir: null,
    });

    expect(prompt).toContain('/geniro:implement https://tracker/x');
    expect(prompt).toContain('I will start by fetching the task.');
    // Labelled, because an opening line and an answer read as one paragraph
    // otherwise and the model titles the pair as though the user said both.
    expect(prompt.indexOf('THE USER OPENED WITH:')).toBeLessThan(
      prompt.indexOf('THE AGENT ANSWERED:'),
    );
  });

  it('omits the agent heading entirely when it has not answered', () => {
    // An empty heading invites the model to fill it in — this is billed per
    // chat and named from whatever is there.
    const prompt = titlePrompt({
      opening: 'add auto chat titles',
      reply: '   ',
      latest: null,
      configDir: null,
    });

    expect(prompt).not.toContain('THE AGENT ANSWERED');
  });

  it('cuts each half to the budget rather than quoting a whole spec', () => {
    const prompt = titlePrompt({
      opening: 'a'.repeat(TITLE_EXCERPT_MAX_CHARS + 500),
      reply: null,
      latest: null,
      configDir: null,
    });

    expect(prompt).toContain(`${'a'.repeat(TITLE_EXCERPT_MAX_CHARS)}…`);
    expect(prompt).not.toContain('a'.repeat(TITLE_EXCERPT_MAX_CHARS + 1));
  });

  it('cuts by CODE POINT, so an emoji is never split into a lone surrogate', () => {
    const prompt = titlePrompt({
      opening: '🚀'.repeat(TITLE_EXCERPT_MAX_CHARS + 10),
      reply: null,
      latest: null,
      configDir: null,
    });

    expect(prompt).not.toContain('\ud83d\ud83d');
    expect(prompt.includes('�')).toBe(false);
  });
});

describe('titlePrompt — what a later ask carries', () => {
  it('adds the latest exchange under its own heading, and only when there is one', () => {
    // The whole reason a second ask is worth making: the same two messages
    // would reproduce the same answer.
    const later = titlePrompt({
      opening: 'https://slack/x',
      reply: 'I will look.',
      latest: 'We settled on rewriting the ETA bindings.',
      configDir: null,
    });
    expect(later).toContain('LATELY THEY HAVE BEEN DISCUSSING');
    expect(later).toContain('rewriting the ETA bindings');

    const first = titlePrompt({
      opening: 'https://slack/x',
      reply: 'I will look.',
      latest: null,
      configDir: null,
    });
    expect(first).not.toContain('LATELY THEY HAVE BEEN DISCUSSING');
  });

  it('tells the model not to ask for the link it cannot open', () => {
    // Measured on 2.1.237 without this line: a bare Slack URL was answered
    // "I need to see the Slack thread to understand what work you're asking
    // about… Could you share what the task is" — a question, used as a title.
    expect(
      titlePrompt({
        opening: 'https://slack/x',
        reply: null,
        latest: null,
        configDir: null,
      }),
    ).toContain('Never ask for anything');
  });
});

describe('readTitleAnswer', () => {
  it('accepts a title and strips the packaging a model adds', () => {
    expect(readTitleAnswer('Resolving TickTick Issues with Confirmation')).toBe(
      'Resolving TickTick Issues with Confirmation',
    );
    expect(readTitleAnswer('  "Fix worktree conflicts"  ')).toBe(
      'Fix worktree conflicts',
    );
    expect(readTitleAnswer('Fix worktree conflicts.')).toBe(
      'Fix worktree conflicts',
    );
  });

  it('declines the refusals a naming turn actually produced', () => {
    // Both VERBATIM from real runs: the first through this daemon on
    // 2.1.237, the second from the naming argv run by hand on a bare Slack
    // link. The first shipped into a sidebar row.
    expect(
      readTitleAnswer(
        "I don't have enough information to name this work yet. You'd need to tell me what the task is.",
      ),
    ).toBeNull();
    expect(
      readTitleAnswer(
        "I need to see the Slack thread to understand what work you're asking about. The URL points to a message, but I can't access external links directly.",
      ),
    ).toBeNull();
  });

  it('declines an answer that is prose by LENGTH rather than by punctuation', () => {
    const wordy = Array.from(
      { length: TITLE_MAX_WORDS + 1 },
      (_, i) => `word${i}`,
    ).join(' ');
    expect(readTitleAnswer(wordy)).toBeNull();
    expect(
      readTitleAnswer(
        Array.from({ length: TITLE_MAX_WORDS }, (_, i) => `word${i}`).join(' '),
      ),
    ).not.toBeNull();
  });

  it('keeps a title whose own words carry a dot, and declines a second sentence', () => {
    expect(readTitleAnswer('Bump vite 7.3 in the UI')).toBe(
      'Bump vite 7.3 in the UI',
    );
    expect(readTitleAnswer('Fix the build. Then ship it')).toBeNull();
  });

  it('answers null for an empty answer', () => {
    expect(readTitleAnswer('   ')).toBeNull();
    expect(readTitleAnswer('""')).toBeNull();
  });
});
