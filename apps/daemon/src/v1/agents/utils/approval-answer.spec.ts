import { afterEach, describe, expect, it } from 'vitest';

import { clearSecrets, redactSecrets } from '../../diagnostics/utils/redact';
import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import type { CardQuestion } from '../adapters/adapter.types';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import {
  answerFoldsInto,
  deliverApprovalAnswer,
  isUserQuestion,
} from './approval-answer';

// The SHIPPED adapters, not doubles: the fold's condition reads
// `config.questionToolName` and the fold itself is `withAnswer`, so a spec
// that restated either would keep passing after the adapter changed the tool
// name or the answer field.
const claude = new ClaudeAdapter();
const cursor = new CursorAcpAdapter({
  vocabularyStore: freshVocabularyStore(),
});

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

const card: CardQuestion = {
  question: 'Which color?',
  header: null,
  options: [],
  multiSelect: false,
};
const secretCard: CardQuestion = {
  ...card,
  question: 'Your API key?',
  secret: true,
};

/** A question request as its `approval_request` event carries it. */
function questionRequest(questions: CardQuestion[] = [card]): {
  toolName: string;
  input: unknown;
  questions: CardQuestion[];
} {
  return { toolName: QUESTION_TOOL, input: QUESTION_INPUT, questions };
}

/**
 * Deliver through a spy: what reached the CLI, and how the debug log would
 * record its frame AT THE MOMENT of the write.
 */
function deliverVia(
  adapter: ClaudeAdapter | CursorAcpAdapter,
  request: Parameters<typeof deliverApprovalAnswer>[1],
  allow: boolean,
  answer: string | undefined,
): {
  delivered: boolean;
  record: { answer?: string };
  sent: unknown;
  loggedAtWrite: string;
} {
  let sent: unknown;
  let loggedAtWrite = '';
  const result = deliverApprovalAnswer(
    adapter,
    request,
    allow,
    answer,
    (input) => {
      sent = input;
      loggedAtWrite = redactSecrets(JSON.stringify(input));
      return true;
    },
  );
  return { ...result, sent, loggedAtWrite };
}

describe('deliverApprovalAnswer — the fold', () => {
  it('folds an allowed answer into the question tool through the adapter, and records it', () => {
    const { sent, record } = deliverVia(claude, questionRequest(), true, 'Red');
    expect(sent).toEqual(claude.withAnswer(QUESTION_INPUT, 'Red'));
    // For a LONE question the adapter's channel is `updatedInput.answers`,
    // keyed by the question's own text; `response` carries a reply given
    // INSTEAD of answering.
    expect(sent).toEqual({
      ...QUESTION_INPUT,
      answers: { 'Which color?': 'Red' },
    });
    expect(record).toEqual({ answer: 'Red' });
    expect(answerFoldsInto(QUESTION_TOOL, QUESTION_TOOL, true, 'Red')).toBe(
      true,
    );
  });

  it('reports the delivery’s own outcome, so a verdict that never landed is not recorded', () => {
    expect(
      deliverApprovalAnswer(claude, questionRequest(), true, 'Red', () => true)
        .delivered,
    ).toBe(true);
    expect(
      deliverApprovalAnswer(claude, questionRequest(), true, 'Red', () => false)
        .delivered,
    ).toBe(false);
  });

  it('echoes the input unchanged for any other tool — the verdict channel must not mutate arbitrary tool args', () => {
    const input = { command: 'ls' };
    const { sent, record } = deliverVia(
      claude,
      { toolName: 'Bash', input },
      true,
      'Red',
    );
    expect(sent).toBe(input);
    expect(record).toEqual({});
    expect(answerFoldsInto(QUESTION_TOOL, 'Bash', true, 'Red')).toBe(false);
  });

  it('never folds or records on deny, or when no answer was given', () => {
    for (const [allow, answer] of [
      [false, 'Red'],
      [true, undefined],
    ] as const) {
      const { sent, record } = deliverVia(
        claude,
        questionRequest(),
        allow,
        answer,
      );
      expect(sent).toBe(QUESTION_INPUT);
      expect(record).toEqual({});
    }
  });

  it('never folds a request named after ANOTHER CLI’s question tool', () => {
    // cursor's question channel has a name of its own, so claude's tool name
    // is an ordinary tool to it — the input is echoed by reference.
    const { sent, record } = deliverVia(cursor, questionRequest(), true, 'Red');
    expect(sent).toBe(QUESTION_INPUT);
    expect(record).toEqual({});
  });
});

describe('isUserQuestion', () => {
  it('recognizes the tool the adapter reported, and nothing else', () => {
    expect(isUserQuestion(QUESTION_TOOL, QUESTION_TOOL)).toBe(true);
    expect(isUserQuestion(QUESTION_TOOL, 'Bash')).toBe(false);
  });

  it('never crosses one CLI’s question tool with another’s', () => {
    // Both adapters declare a channel now, and they declare DIFFERENT names —
    // cursor's is its `cursor/ask_question` method, claude's is a tool. The
    // discriminator has to be read against the adapter that raised the
    // request: matched loosely, one CLI's permission check could be mistaken
    // for the other's question and skip the human gate.
    const cursorTool = cursor.getConfig().questionToolName;
    expect(cursorTool).not.toBeNull();
    expect(cursorTool).not.toBe(QUESTION_TOOL);

    expect(isUserQuestion(cursorTool, QUESTION_TOOL)).toBe(false);
    expect(isUserQuestion(QUESTION_TOOL, cursorTool ?? '')).toBe(false);
    expect(isUserQuestion(cursorTool, cursorTool ?? '')).toBe(true);
  });

  it('finds no question at all for a CLI that declares no channel', () => {
    // The null arm still has to work: it is what a CLI with no question
    // channel declares, and nothing it raises may ever be treated as one.
    expect(isUserQuestion(null, QUESTION_TOOL)).toBe(false);
  });
});

describe('deliverApprovalAnswer — a secret answer', () => {
  afterEach(() => {
    clearSecrets();
  });

  const SECRET = 'sk-live-0123456789abcdef';

  it('delivers the answer, records none of it, and masks it in the debug log', () => {
    // The row is SQLite and replays to every client; the secret reaches the
    // agent alone. Long enough to mask everywhere, it stays masked after the
    // write too — an agent repeating it later is scrubbed as well.
    const { sent, record, loggedAtWrite } = deliverVia(
      claude,
      questionRequest([secretCard]),
      true,
      SECRET,
    );

    expect(sent).toEqual(claude.withAnswer(QUESTION_INPUT, SECRET));
    expect(record).toEqual({});
    expect(loggedAtWrite).not.toContain(SECRET);
    expect(redactSecrets(`wrote ${SECRET} to stdin`)).not.toContain(SECRET);
  });

  it('masks it as the JSON frame that carries it spells it', () => {
    // Escaping rewrites a quote, a backslash or a tab, and the stdio channel
    // records the frame rather than the value.
    const typed = 'pa"ss\\word\t0123';
    deliverVia(claude, questionRequest([secretCard]), true, typed);

    const frame = redactSecrets(JSON.stringify({ answers: [typed] }));
    expect(frame).not.toContain('0123');
    expect(frame).toContain('secret answer redacted');
  });

  it('masks a short secret in the frame that delivers it, and nowhere after', () => {
    // Masked everywhere, a PIN would be given away by the sequence numbers and
    // timestamps it blanked around itself.
    const { loggedAtWrite } = deliverVia(
      claude,
      questionRequest([secretCard]),
      true,
      '4821',
    );

    expect(loggedAtWrite).not.toContain('4821');
    expect(loggedAtWrite).toContain('secret answer redacted');
    expect(redactSecrets('item seq=4821')).toBe('item seq=4821');
  });

  it('masks nothing shorter than four characters', () => {
    const { loggedAtWrite } = deliverVia(
      claude,
      questionRequest([secretCard]),
      true,
      '482',
    );

    expect(loggedAtWrite).toContain('482');
  });

  it('masks the secret question’s own value on a card of several questions', () => {
    // The card submits one labelled line per question, so an agent repeating
    // the key later repeats the VALUE — never the whole submission.
    deliverVia(
      claude,
      questionRequest([card, secretCard]),
      true,
      'Which color?: teal-and-orange\nYour API key?: ghp_0123456789abcdef',
    );

    expect(redactSecrets('export KEY=ghp_0123456789abcdef')).not.toContain(
      'ghp_0123456789abcdef',
    );
    // The plain question's value is not a secret on its own.
    expect(redactSecrets('paint it teal-and-orange')).toBe(
      'paint it teal-and-orange',
    );
  });
});
