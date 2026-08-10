import { describe, expect, it } from 'vitest';

import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import {
  answerFoldsInto,
  foldApprovalAnswer,
  isUserQuestion,
} from './approval-answer';

// The SHIPPED adapters, not doubles: the fold's condition reads
// `config.questionToolName` and the fold itself is `withAnswer`, so a spec
// that restated either would keep passing after the adapter changed the tool
// name or the answer field.
const claude = new ClaudeAdapter();
const cursor = new CursorAcpAdapter();

const { questionToolName } = claude.getConfig();
if (questionToolName === null) {
  // Loud, not skipped: every case below is about the tool claude declares.
  throw new Error('ClaudeAdapter declares no question tool');
}
/** What ClaudeAdapter.getConfig().questionToolName reports. */
const QUESTION_TOOL: string = questionToolName;

const QUESTION_INPUT = {
  questions: [{ question: 'Which color?', options: [{ label: 'Red' }] }],
};

describe('foldApprovalAnswer', () => {
  it('folds an allowed answer into the question tool through the adapter', () => {
    expect(
      foldApprovalAnswer(claude, QUESTION_TOOL, QUESTION_INPUT, true, 'Red'),
    ).toEqual(claude.withAnswer(QUESTION_INPUT, 'Red'));
    // For a LONE question the adapter's channel is `updatedInput.answers`,
    // keyed by the question's own text; `response` carries a reply given
    // INSTEAD of answering.
    expect(
      foldApprovalAnswer(claude, QUESTION_TOOL, QUESTION_INPUT, true, 'Red'),
    ).toEqual({ ...QUESTION_INPUT, answers: { 'Which color?': 'Red' } });
    expect(answerFoldsInto(QUESTION_TOOL, QUESTION_TOOL, true, 'Red')).toBe(
      true,
    );
  });

  it('echoes the input unchanged for any other tool — the verdict channel must not mutate arbitrary tool args', () => {
    const input = { command: 'ls' };
    expect(foldApprovalAnswer(claude, 'Bash', input, true, 'Red')).toBe(input);
    expect(answerFoldsInto(QUESTION_TOOL, 'Bash', true, 'Red')).toBe(false);
  });

  it('never folds on deny or when no answer was given', () => {
    expect(
      foldApprovalAnswer(claude, QUESTION_TOOL, QUESTION_INPUT, false, 'Red'),
    ).toBe(QUESTION_INPUT);
    expect(
      foldApprovalAnswer(
        claude,
        QUESTION_TOOL,
        QUESTION_INPUT,
        true,
        undefined,
      ),
    ).toBe(QUESTION_INPUT);
  });

  it('never folds for a CLI with no question channel, whatever the tool is called', () => {
    // cursor-agent declares questionToolName null, so no tool name it could
    // ever raise reaches the fold — the input is echoed by reference.
    expect(
      foldApprovalAnswer(cursor, QUESTION_TOOL, QUESTION_INPUT, true, 'Red'),
    ).toBe(QUESTION_INPUT);
  });
});

describe('isUserQuestion', () => {
  it('recognizes the tool the adapter reported, and nothing else', () => {
    expect(isUserQuestion(QUESTION_TOOL, QUESTION_TOOL)).toBe(true);
    expect(isUserQuestion(QUESTION_TOOL, 'Bash')).toBe(false);
  });

  it('finds no question at all for a CLI with no question channel', () => {
    // cursor-agent reports null: every request it could raise is a permission
    // check, so nothing may ever be treated as a user question.
    expect(cursor.getConfig().questionToolName).toBeNull();
    expect(
      isUserQuestion(cursor.getConfig().questionToolName, QUESTION_TOOL),
    ).toBe(false);
  });
});
