import { describe, expect, it } from 'vitest';

import { readClaudeTitleReply } from './claude-title.utils';

/** The reply shape, as `--output-format json` produced it on 2.1.237. */
function reply(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 4775,
    ...fields,
  });
}

describe('readClaudeTitleReply', () => {
  it('reads the title out of the reply', () => {
    expect(
      readClaudeTitleReply(
        reply({ result: 'Implement TickTick task with screenshots' }),
      ),
    ).toBe('Implement TickTick task with screenshots');
  });

  it('refuses a FAILED turn, whose error text sits in the same field', () => {
    // The one thing that separates an answer from a complaint here — without
    // it, `Credit balance is too low` becomes the chat's name.
    expect(
      readClaudeTitleReply(
        reply({ is_error: true, result: 'Credit balance is too low' }),
      ),
    ).toBeNull();
  });

  it('takes off the packaging a model adds when it ignores the ask', () => {
    expect(
      readClaudeTitleReply(reply({ result: '"Fix the flaky suite"' })),
    ).toBe('Fix the flaky suite');
    expect(
      readClaudeTitleReply(reply({ result: 'Fix the flaky suite.' })),
    ).toBe('Fix the flaky suite');
  });

  it('keeps a title that merely CONTAINS the packaging characters', () => {
    // A quote around one word is the title, not a wrapper, and an ellipsis is
    // not a full stop.
    expect(
      readClaudeTitleReply(reply({ result: 'Rename the "run" column' })),
    ).toBe('Rename the "run" column');
  });

  it('answers null for everything it cannot read', () => {
    expect(readClaudeTitleReply(null)).toBeNull();
    expect(readClaudeTitleReply('not json at all')).toBeNull();
    expect(readClaudeTitleReply(reply({ result: '   ' }))).toBeNull();
    expect(readClaudeTitleReply(reply({ result: 42 }))).toBeNull();
  });
});
