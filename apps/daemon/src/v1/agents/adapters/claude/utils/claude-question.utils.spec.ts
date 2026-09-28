import { describe, expect, it } from 'vitest';

import {
  MAX_ANSWER_LENGTH,
  MAX_QUESTION_HEADER_LENGTH,
} from '../../../chat.types';
import { claudeCardQuestions, withResponse } from './claude-question.utils';

const INPUT = {
  questions: [
    {
      question: 'Which color?',
      header: 'Color',
      options: [{ label: 'Red' }, { label: 'Blue' }],
      multiSelect: false,
    },
    { question: 'Deploy now?', options: [{ label: 'Yes' }] },
  ],
};

/** A card option as `claudeCardQuestions` writes one carrying a label alone. */
const option = (label: string) => ({ label, description: null, preview: null });

describe('claude question projections', () => {
  it('pins the twin limits to the NUMBERS the renderer restates as literals', () => {
    // The renderer card cannot import these — there is no daemon↔renderer
    // shared package, which is why the two parsers are declared TWINS — so it
    // hardcodes 32_768 and 64. Every other test here derives its expectation
    // from the constant, which means a change to either would sail through the
    // daemon suite while silently diverging from the card. These two lines are
    // what turn that drift into a failure on this side.
    expect(MAX_ANSWER_LENGTH).toBe(32_768);
    expect(MAX_QUESTION_HEADER_LENGTH).toBe(64);
  });

  it('reads claude’s questions, headers, option labels and multi-pick into the card', () => {
    // WHERE each of these sits in claude's payload is this file's to know;
    // what the card and the caller's envelope then do with them is the shared
    // code in card-questions.ts, pinned beside it.
    expect(claudeCardQuestions(INPUT)).toEqual([
      {
        question: 'Which color?',
        header: 'Color',
        multiSelect: false,
        options: [option('Red'), option('Blue')],
      },
      {
        question: 'Deploy now?',
        header: null,
        multiSelect: false,
        options: [option('Yes')],
      },
    ]);
    expect(
      claudeCardQuestions({
        questions: [{ question: 'Which files?', multiSelect: true }],
      })[0]?.multiSelect,
    ).toBe(true);
  });

  it('carries an option’s description and preview, which only the card shows', () => {
    expect(
      claudeCardQuestions({
        questions: [
          {
            question: 'Which plan?',
            options: [{ label: 'A', description: 'safer', preview: '# A' }],
          },
        ],
      })[0]?.options,
    ).toEqual([{ label: 'A', description: 'safer', preview: '# A' }]);
  });

  it('reads a non-string header as none, and a truthy non-true multiSelect as false', () => {
    // TWIN PARSER rule: a truthy STRING would let one twin offer multi-pick
    // while the other offers one.
    expect(
      claudeCardQuestions({
        questions: [
          { question: 'c', header: 42 },
          { question: 'd', multiSelect: 'yes' },
        ],
      }).map(({ header, multiSelect }) => ({ header, multiSelect })),
    ).toEqual([
      { header: null, multiSelect: false },
      { header: null, multiSelect: false },
    ]);
  });

  it('reads a malformed payload as no question at all instead of throwing', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'text',
      [],
      {},
      { questions: 'nope' },
      { questions: [null, 7, { noQuestion: true }, { question: 42 }] },
    ]) {
      expect(claudeCardQuestions(bad)).toEqual([]);
    }
  });

  it('keeps the entries that parse and drops the parts that do not', () => {
    // A non-array options field is dropped while its question survives.
    expect(
      claudeCardQuestions({ questions: [{ question: 'ok', options: 'nope' }] }),
    ).toEqual([
      { question: 'ok', header: null, multiSelect: false, options: [] },
    ]);
    expect(
      claudeCardQuestions({
        questions: [{ question: 'ok', options: [{ label: 'A' }, { bad: 1 }] }],
      })[0]?.options,
    ).toEqual([option('A')]);
  });

  it('withResponse keeps SEVERAL questions on `response`', () => {
    // One answer string cannot be split back into two answers without guessing
    // at a boundary inside the user's own words, so the blob channel is the
    // honest one until the verdict carries per-question structure.
    expect(withResponse(INPUT, 'Blue')).toEqual({
      ...INPUT,
      response: 'Blue',
    });
    // Non-object inputs still produce a schema-shaped answer carrier.
    expect(withResponse(null, 'x')).toEqual({ response: 'x' });
    expect(withResponse('junk', 'x')).toEqual({ response: 'x' });
  });

  it('withResponse puts a LONE question on the CLI’s `answers` channel', () => {
    // Probe-verified on 2.1.226: `answers` makes the CLI tell the model
    // `Your questions have been answered: "Which color?"="Blue"`, keyed per
    // question, while `response` yields `The user responded: Blue` and
    // documents itself as a reply given INSTEAD of answering the questions.
    const lone = { questions: [INPUT.questions[0]] };

    expect(withResponse(lone, 'Blue')).toEqual({
      ...lone,
      answers: { 'Which color?': 'Blue' },
    });
  });

  it('a lone question keyed by its own TEXT, never by position or header', () => {
    // The key is what the CLI matches the answer back to its question with —
    // its `header` ("Color") would silently answer nothing.
    const answered = withResponse(
      { questions: [INPUT.questions[0]] },
      'Blue',
    ) as { answers: Record<string, string>; response?: string };

    expect(Object.keys(answered.answers)).toEqual(['Which color?']);
    // And the blob channel stays OUT of it: setting both would have the CLI
    // discard the per-question list it was just given.
    expect(answered.response).toBeUndefined();
  });

  it('a malformed lone-question payload still carries the answer somewhere', () => {
    // The card drops an entry with no question text, so this reads as ZERO
    // questions — the answer must not vanish with them.
    expect(withResponse({ questions: [{ options: [] }] }, 'x')).toEqual({
      questions: [{ options: [] }],
      response: 'x',
    });
  });
});
