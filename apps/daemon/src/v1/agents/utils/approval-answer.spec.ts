import { describe, expect, it } from 'vitest';

import {
  answerFoldsInto,
  foldApprovalAnswer,
  isUserQuestion,
} from './approval-answer';

/** What ClaudeAdapter.questionToolName reports. */
const QUESTION_TOOL = 'AskUserQuestion';

const QUESTION_INPUT = {
  questions: [{ question: 'Which color?', options: [{ label: 'Red' }] }],
};

describe('foldApprovalAnswer', () => {
  it('folds an allowed answer into AskUserQuestion as updatedInput.response', () => {
    expect(
      foldApprovalAnswer(
        QUESTION_TOOL,
        'AskUserQuestion',
        QUESTION_INPUT,
        true,
        'Red',
      ),
    ).toEqual({ ...QUESTION_INPUT, response: 'Red' });
    expect(answerFoldsInto(QUESTION_TOOL, 'AskUserQuestion', true, 'Red')).toBe(
      true,
    );
  });

  it('echoes the input unchanged for any other tool — the verdict channel must not mutate arbitrary tool args', () => {
    const input = { command: 'ls' };
    expect(foldApprovalAnswer(QUESTION_TOOL, 'Bash', input, true, 'Red')).toBe(
      input,
    );
    expect(answerFoldsInto(QUESTION_TOOL, 'Bash', true, 'Red')).toBe(false);
  });

  it('never folds on deny or when no answer was given', () => {
    expect(
      foldApprovalAnswer(
        QUESTION_TOOL,
        'AskUserQuestion',
        QUESTION_INPUT,
        false,
        'Red',
      ),
    ).toBe(QUESTION_INPUT);
    expect(
      foldApprovalAnswer(
        QUESTION_TOOL,
        'AskUserQuestion',
        QUESTION_INPUT,
        true,
        undefined,
      ),
    ).toBe(QUESTION_INPUT);
  });
});

describe('isUserQuestion', () => {
  it('recognizes the tool the adapter reported, and nothing else', () => {
    expect(isUserQuestion(QUESTION_TOOL, 'AskUserQuestion')).toBe(true);
    expect(isUserQuestion(QUESTION_TOOL, 'Bash')).toBe(false);
  });

  it('finds no question at all for a CLI with no question channel', () => {
    // cursor-agent reports null: every request it could raise is a permission
    // check, so nothing may ever be treated as a user question.
    expect(isUserQuestion(null, 'AskUserQuestion')).toBe(false);
  });
});
