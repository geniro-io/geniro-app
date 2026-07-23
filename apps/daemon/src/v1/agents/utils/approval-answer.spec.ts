import { describe, expect, it } from 'vitest';

import { answerFoldsInto, foldApprovalAnswer } from './approval-answer';

const QUESTION_INPUT = {
  questions: [{ question: 'Which color?', options: [{ label: 'Red' }] }],
};

describe('foldApprovalAnswer', () => {
  it('folds an allowed answer into AskUserQuestion as updatedInput.response', () => {
    expect(
      foldApprovalAnswer('AskUserQuestion', QUESTION_INPUT, true, 'Red'),
    ).toEqual({ ...QUESTION_INPUT, response: 'Red' });
    expect(answerFoldsInto('AskUserQuestion', true, 'Red')).toBe(true);
  });

  it('echoes the input unchanged for any other tool — the verdict channel must not mutate arbitrary tool args', () => {
    const input = { command: 'ls' };
    expect(foldApprovalAnswer('Bash', input, true, 'Red')).toBe(input);
    expect(answerFoldsInto('Bash', true, 'Red')).toBe(false);
  });

  it('never folds on deny or when no answer was given', () => {
    expect(
      foldApprovalAnswer('AskUserQuestion', QUESTION_INPUT, false, 'Red'),
    ).toBe(QUESTION_INPUT);
    expect(
      foldApprovalAnswer('AskUserQuestion', QUESTION_INPUT, true, undefined),
    ).toBe(QUESTION_INPUT);
  });
});
