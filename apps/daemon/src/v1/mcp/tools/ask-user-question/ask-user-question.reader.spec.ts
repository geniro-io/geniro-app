import { describe, expect, it } from 'vitest';

import { MAX_HOST_QUESTION_TITLE_LENGTH } from '../../../agents/utils/host-question';
import {
  hostQuestionResultText,
  readHostQuestionTitle,
} from './ask-user-question.reader';

describe('readHostQuestionTitle', () => {
  it('reads a title and truncates it to its cap', () => {
    expect(readHostQuestionTitle({ title: 'Pick a database' })).toBe(
      'Pick a database',
    );
    expect(
      readHostQuestionTitle({
        title: 't'.repeat(MAX_HOST_QUESTION_TITLE_LENGTH + 50),
      }),
    ).toHaveLength(MAX_HOST_QUESTION_TITLE_LENGTH);
  });

  it('answers null for a title that is absent, blank or not a string', () => {
    expect(readHostQuestionTitle({})).toBeNull();
    expect(readHostQuestionTitle({ title: '   ' })).toBeNull();
    expect(readHostQuestionTitle({ title: 7 })).toBeNull();
  });
});

describe('hostQuestionResultText', () => {
  it('tells the three outcomes apart, so a refusal never reads as an answer', () => {
    const answered = hostQuestionResultText({
      status: 'answered',
      answer: 'Postgres',
    });
    const declined = hostQuestionResultText({ status: 'declined' });
    const unavailable = hostQuestionResultText({
      status: 'unavailable',
      reason: 'the turn ended',
    });
    expect(answered).toContain('Postgres');
    expect(declined).not.toBe(answered);
    expect(unavailable).not.toBe(declined);
    expect(declined).toMatch(/dismissed/i);
    expect(unavailable).toContain('the turn ended');
  });
});

describe('the deferred arm', () => {
  it('tells the agent to stop and wait rather than to ask again', () => {
    const posted = hostQuestionResultText({ status: 'posted' });

    // Every clause answers a way the turn went wrong before it existed: the
    // model carrying on and guessing, the model re-asking (which raises no new
    // card and only spends a turn), and the model failing to recognise its next
    // user message as the reply.
    expect(posted).toMatch(/stop/i);
    expect(posted).toMatch(/again/i);
    expect(posted).toMatch(/next user message/i);
    // It is not an ending, so it must not read like the other three.
    expect(posted).not.toBe(hostQuestionResultText({ status: 'declined' }));
  });
});
