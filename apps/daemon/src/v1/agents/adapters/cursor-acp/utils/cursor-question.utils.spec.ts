import { describe, expect, it } from 'vitest';

import {
  cursorAdapterQuestion,
  encodeCursorQuestionReply,
  readCursorQuestions,
  withCursorAnswer,
} from './cursor-question.utils';

/**
 * A `cursor/ask_question` params object in the documented shape
 * (`cursor.com/docs/cli/acp`). Not transcribed from a live sighting — see the
 * block above CURSOR_ASK_QUESTION_METHOD — which is exactly why the
 * unreadable-payload cases below matter as much as the happy path.
 */
function askParams(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    toolCallId: 'tool_1',
    questions: [
      {
        id: 'q1',
        prompt: 'Which color?',
        options: [
          { id: 'red', label: 'Red' },
          { id: 'blue', label: 'Blue' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('readCursorQuestions', () => {
  it('reads the documented shape', () => {
    expect(readCursorQuestions(askParams())).toEqual([
      {
        id: 'q1',
        prompt: 'Which color?',
        options: [
          { id: 'red', label: 'Red' },
          { id: 'blue', label: 'Blue' },
        ],
        allowMultiple: false,
      },
    ]);
  });

  it('drops a question with no options', () => {
    // `selectedOptionIds` is the only answer channel the response shape has,
    // so a free-text question could be shown and then never answered.
    expect(
      readCursorQuestions(
        askParams({ questions: [{ id: 'q1', prompt: 'Why?', options: [] }] }),
      ),
    ).toEqual([]);
  });

  it('falls back to the option id when the agent labels nothing', () => {
    const read = readCursorQuestions(
      askParams({
        questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'red' }] }],
      }),
    );
    expect(read[0]?.options).toEqual([{ id: 'red', label: 'red' }]);
  });

  it('reads an unrecognized payload as no questions, never as a throw', () => {
    // This return is what makes the driver DECLINE — the pre-existing
    // behaviour — instead of parking a card built from a payload it could not
    // parse. It is the whole safety net under a documented-not-probed shape.
    expect(readCursorQuestions(null)).toEqual([]);
    expect(readCursorQuestions('nonsense')).toEqual([]);
    expect(readCursorQuestions({ questions: 'nope' })).toEqual([]);
    expect(readCursorQuestions({ questions: [{ prompt: 'no id' }] })).toEqual(
      [],
    );
  });
});

describe('cursorAdapterQuestion', () => {
  it('projects text and flat option labels, the shared card contract', () => {
    expect(cursorAdapterQuestion(askParams())).toEqual({
      text: 'Which color?',
      options: ['Red', 'Blue'],
    });
  });

  it('leads with the request title when there is more than one question', () => {
    const params = askParams({
      title: 'Set up the review',
      questions: [
        {
          id: 'q1',
          prompt: 'Which color?',
          options: [{ id: 'red', label: 'Red' }],
        },
        {
          id: 'q2',
          prompt: 'Which size?',
          options: [{ id: 'big', label: 'Big' }],
        },
      ],
    });
    expect(cursorAdapterQuestion(params)).toEqual({
      text: 'Set up the review',
      options: ['Red', 'Big'],
    });
  });

  it('answers null for a payload carrying no readable question', () => {
    expect(cursorAdapterQuestion({ questions: [] })).toBeNull();
  });
});

describe('encodeCursorQuestionReply', () => {
  const params = askParams();

  it('answers with the option the user picked, matched on its label', () => {
    const updated = withCursorAnswer(params, 'Blue');
    expect(encodeCursorQuestionReply(params, true, updated)).toEqual({
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['blue'] }],
      },
    });
  });

  it('matches a label case-insensitively, and matches a raw option id too', () => {
    // The card shows labels, so an answer echoing one is the ordinary case;
    // a caller agent answering off the envelope may send the id instead.
    for (const answer of ['blue', 'BLUE', ' Blue ', 'blue']) {
      expect(
        encodeCursorQuestionReply(
          params,
          true,
          withCursorAnswer(params, answer),
        ),
      ).toEqual({
        outcome: {
          outcome: 'answered',
          answers: [{ questionId: 'q1', selectedOptionIds: ['blue'] }],
        },
      });
    }
  });

  it('SKIPS with the text as its reason when the answer names no option', () => {
    // The protocol has no free-text channel. Inventing a selectedOptionIds
    // from an unmatched string would answer the agent with a choice the user
    // did not make; `reason` is what still carries their words across.
    expect(
      encodeCursorQuestionReply(
        params,
        true,
        withCursorAnswer(params, 'neither, use green'),
      ),
    ).toEqual({
      outcome: { outcome: 'skipped', reason: 'neither, use green' },
    });
  });

  it('skips a denied verdict, and says nothing the user did not say', () => {
    expect(encodeCursorQuestionReply(params, false, params)).toEqual({
      outcome: { outcome: 'skipped' },
    });
  });

  it('skips an allowed verdict that carried no answer at all', () => {
    // The card can be dismissed without text. There is no option to report.
    expect(encodeCursorQuestionReply(params, true, params)).toEqual({
      outcome: { outcome: 'skipped' },
    });
  });

  it('answers every question of a multi-question ask, or none of them', () => {
    const multi = askParams({
      questions: [
        {
          id: 'q1',
          prompt: 'Which color?',
          options: [{ id: 'red', label: 'Red' }],
        },
        {
          id: 'q2',
          prompt: 'Which size?',
          options: [{ id: 'big', label: 'Big' }],
        },
      ],
    });
    // One free-text answer cannot name an option of BOTH questions, so a
    // partial `answered` would silently invent a choice for the second.
    expect(
      encodeCursorQuestionReply(multi, true, withCursorAnswer(multi, 'Red')),
    ).toEqual({ outcome: { outcome: 'skipped', reason: 'Red' } });
  });
});
