import { describe, expect, it } from 'vitest';

import { MAX_ANSWER_LABEL_LENGTH } from '../../../utils/card-questions';
import {
  cursorCardQuestions,
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

describe('cursorCardQuestions', () => {
  it('projects each question as a card with no title of its own', () => {
    expect(
      cursorCardQuestions(
        askParams({
          title: 'The whole ask',
          questions: [
            {
              id: 'q1',
              prompt: 'Which colors?',
              allowMultiple: true,
              // An unlabelled option is offered under its id — the one the
              // reply is matched back to.
              options: [{ id: 'red', label: 'Red' }, { id: 'blue' }],
            },
          ],
        }),
      ),
    ).toEqual([
      {
        question: 'Which colors?',
        header: null,
        multiSelect: true,
        options: [
          { label: 'Red', description: null, preview: null },
          { label: 'blue', description: null, preview: null },
        ],
      },
    ]);
  });

  it('offers no card for a payload it cannot read', () => {
    expect(cursorCardQuestions({ questions: 'nope' })).toEqual([]);
  });
});

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

  it('answers a multi-select question with every option the card joined', () => {
    // The card submits several picks as one comma-joined string, and this is
    // the only channel that can carry them: cursor's own -32601 fallback
    // filters `allowMultiple` questions out and never asks them at all.
    const multi = askParams({
      questions: [
        {
          id: 'q1',
          prompt: 'Which layers?',
          allowMultiple: true,
          options: [
            { id: 'daemon', label: 'The daemon' },
            { id: 'renderer', label: 'The renderer' },
            { id: 'adapters', label: 'The adapters' },
          ],
        },
      ],
    });
    expect(
      encodeCursorQuestionReply(
        multi,
        true,
        withCursorAnswer(multi, 'The daemon, The adapters'),
      ),
    ).toEqual({
      outcome: {
        outcome: 'answered',
        answers: [
          { questionId: 'q1', selectedOptionIds: ['daemon', 'adapters'] },
        ],
      },
    });
  });

  it('does NOT split a single-select answer that happens to contain a comma', () => {
    // "Red, Blue" to a pick-one question is not a pick of Red. Reading it as
    // one would report a choice the user did not make.
    expect(
      encodeCursorQuestionReply(
        params,
        true,
        withCursorAnswer(params, 'Red, Blue'),
      ),
    ).toEqual({ outcome: { outcome: 'skipped', reason: 'Red, Blue' } });
  });

  it('prefers a whole-string match, so a label with a comma still matches', () => {
    const commas = askParams({
      questions: [
        {
          id: 'q1',
          prompt: 'Which?',
          allowMultiple: true,
          options: [
            { id: 'both', label: 'Red, then blue' },
            { id: 'red', label: 'Red' },
          ],
        },
      ],
    });
    expect(
      encodeCursorQuestionReply(
        commas,
        true,
        withCursorAnswer(commas, 'Red, then blue'),
      ),
    ).toEqual({
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['both'] }],
      },
    });
  });

  it('skips a multi-select answer naming anything not on offer', () => {
    // All or nothing: a partial read would drop a choice the user made while
    // reporting the rest as their complete answer.
    const multi = askParams({
      questions: [
        {
          id: 'q1',
          prompt: 'Which layers?',
          allowMultiple: true,
          options: [{ id: 'daemon', label: 'The daemon' }],
        },
      ],
    });
    expect(
      encodeCursorQuestionReply(
        multi,
        true,
        withCursorAnswer(multi, 'The daemon, The moon'),
      ),
    ).toEqual({
      outcome: { outcome: 'skipped', reason: 'The daemon, The moon' },
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

  describe('a card of several questions', () => {
    // The card submits ONE string for the whole ask: a `<question>: <answer>`
    // line per question, joined by a newline, in card order. The renderer
    // writes it and this daemon cannot import that, so each case spells the
    // lines out by hand — as `card-questions.spec.ts` does for the same twin.
    const colorAndSize = askParams({
      questions: [
        {
          id: 'q1',
          prompt: 'Which color?',
          options: [
            { id: 'red', label: 'Red' },
            { id: 'blue', label: 'Blue' },
          ],
        },
        {
          id: 'q2',
          prompt: 'Which size?',
          options: [
            { id: 'big', label: 'Big' },
            { id: 'small', label: 'Small' },
          ],
        },
      ],
    });

    function submit(ask: Record<string, unknown>, submission: string): unknown {
      return encodeCursorQuestionReply(
        ask,
        true,
        withCursorAnswer(ask, submission),
      );
    }

    it('answers each question from its own line, with that question’s own option id', () => {
      expect(
        submit(colorAndSize, 'Which color?: Blue\nWhich size?: Small'),
      ).toEqual({
        outcome: {
          outcome: 'answered',
          answers: [
            { questionId: 'q1', selectedOptionIds: ['blue'] },
            { questionId: 'q2', selectedOptionIds: ['small'] },
          ],
        },
      });
    });

    it('answers a multi-select question from its line, with every pick the card joined', () => {
      const withLayers = askParams({
        questions: [
          {
            id: 'q1',
            prompt: 'Which color?',
            options: [
              { id: 'red', label: 'Red' },
              { id: 'blue', label: 'Blue' },
            ],
          },
          {
            id: 'q2',
            prompt: 'Which layers?',
            allowMultiple: true,
            options: [
              { id: 'daemon', label: 'The daemon' },
              { id: 'renderer', label: 'The renderer' },
              { id: 'adapters', label: 'The adapters' },
            ],
          },
        ],
      });
      expect(
        submit(
          withLayers,
          'Which color?: Red\nWhich layers?: The daemon, The adapters',
        ),
      ).toEqual({
        outcome: {
          outcome: 'answered',
          answers: [
            { questionId: 'q1', selectedOptionIds: ['red'] },
            { questionId: 'q2', selectedOptionIds: ['daemon', 'adapters'] },
          ],
        },
      });
    });

    it('finds the line of a question whose label the card cut short', () => {
      // A label is the question's text cut to MAX_ANSWER_LABEL_LENGTH with a
      // trailing `…`, so an over-long question is not on its own line verbatim.
      const long = `${'x'.repeat(MAX_ANSWER_LABEL_LENGTH + 5)}?`;
      const label = `${long.slice(0, MAX_ANSWER_LABEL_LENGTH - 1)}…`;
      const cut = askParams({
        questions: [
          {
            id: 'q1',
            prompt: 'Which color?',
            options: [{ id: 'red', label: 'Red' }],
          },
          {
            id: 'q2',
            prompt: long,
            options: [
              { id: 'big', label: 'Big' },
              { id: 'small', label: 'Small' },
            ],
          },
        ],
      });
      expect(submit(cut, `Which color?: Red\n${label}: Small`)).toEqual({
        outcome: {
          outcome: 'answered',
          answers: [
            { questionId: 'q1', selectedOptionIds: ['red'] },
            { questionId: 'q2', selectedOptionIds: ['small'] },
          ],
        },
      });
    });

    it('SKIPS with the whole answer when a question has no line of its own', () => {
      // An `answered` naming only the first question would tell the agent the
      // second had been decided, when the user's text says nothing about it.
      expect(submit(colorAndSize, 'Which color?: Red')).toEqual({
        outcome: { outcome: 'skipped', reason: 'Which color?: Red' },
      });
    });

    it('gives a lone question the whole answer, colon and all', () => {
      // A lone question's submission is the bare answer, never a labelled
      // line, so a label that itself contains `: ` must still match whole.
      const lone = askParams({
        questions: [
          {
            id: 'q1',
            prompt: 'Which database?',
            options: [{ id: 'pg', label: 'Postgres: managed' }],
          },
        ],
      });
      expect(submit(lone, 'Postgres: managed')).toEqual({
        outcome: {
          outcome: 'answered',
          answers: [{ questionId: 'q1', selectedOptionIds: ['pg'] }],
        },
      });
    });

    it('reads the whole answer for every question when one of them never reached the card', () => {
      // A question with no prompt is kept by the reader and dropped by the
      // card, so the user was shown ONE question of two and no index of the
      // cards is the same question here. Splitting by position would hand a
      // question its neighbour's line, so each is offered the whole answer, as
      // a lone question is.
      const dropped = askParams({
        questions: [
          { id: 'q1', prompt: '', options: [{ id: 'hidden', label: 'Yes' }] },
          {
            id: 'q2',
            prompt: 'Ship it?',
            options: [{ id: 'ship', label: 'Yes' }],
          },
        ],
      });
      expect(cursorCardQuestions(dropped)).toHaveLength(1);
      expect(submit(dropped, 'Yes')).toEqual({
        outcome: {
          outcome: 'answered',
          answers: [
            { questionId: 'q1', selectedOptionIds: ['hidden'] },
            { questionId: 'q2', selectedOptionIds: ['ship'] },
          ],
        },
      });
    });
  });
});
