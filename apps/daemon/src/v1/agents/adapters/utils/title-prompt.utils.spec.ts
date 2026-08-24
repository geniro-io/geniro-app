import { describe, expect, it } from 'vitest';

import { TITLE_EXCERPT_MAX_CHARS, titlePrompt } from './title-prompt.utils';

describe('titlePrompt', () => {
  it('quotes both halves of the exchange under their own headings', () => {
    const prompt = titlePrompt({
      opening: '/geniro:implement https://tracker/x',
      reply: 'I will start by fetching the task.',
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
      configDir: null,
    });

    expect(prompt).not.toContain('THE AGENT ANSWERED');
  });

  it('cuts each half to the budget rather than quoting a whole spec', () => {
    const prompt = titlePrompt({
      opening: 'a'.repeat(TITLE_EXCERPT_MAX_CHARS + 500),
      reply: null,
      configDir: null,
    });

    expect(prompt).toContain(`${'a'.repeat(TITLE_EXCERPT_MAX_CHARS)}…`);
    expect(prompt).not.toContain('a'.repeat(TITLE_EXCERPT_MAX_CHARS + 1));
  });

  it('cuts by CODE POINT, so an emoji is never split into a lone surrogate', () => {
    const prompt = titlePrompt({
      opening: '🚀'.repeat(TITLE_EXCERPT_MAX_CHARS + 10),
      reply: null,
      configDir: null,
    });

    expect(prompt).not.toContain('\ud83d\ud83d');
    expect(prompt.includes('�')).toBe(false);
  });
});
