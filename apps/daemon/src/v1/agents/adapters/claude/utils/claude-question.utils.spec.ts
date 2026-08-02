import { describe, expect, it } from 'vitest';

import {
  MAX_ANSWER_LENGTH,
  MAX_QUESTION_HEADER_LENGTH,
} from '../../../chat.types';
import {
  optionLabelsOf,
  questionTextOf,
  withResponse,
} from './claude-question.utils';

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

  it('projects the question text, qualified by header (multi-question joins per line)', () => {
    // The envelope's `options` are FLAT across questions, so the header is the
    // only thing telling a caller which option belongs to which question.
    expect(questionTextOf(INPUT)).toBe('[Color] Which color?\nDeploy now?');
  });

  it('discloses multiSelect so a caller knows more than one label is wanted', () => {
    expect(
      questionTextOf({
        questions: [
          { question: 'Which files?', header: 'Files', multiSelect: true },
        ],
      }),
    ).toBe('[Files] Which files? (pick one or more)');
  });

  it('drops an empty or oversized header, and treats a truthy non-true multiSelect as false', () => {
    // TWIN PARSER rule: a header is a tab title on the renderer side, where an
    // unbounded one would push the answer controls off the card; and a truthy
    // STRING would let one twin offer multi-pick while the other offers one.
    const oversized = 'h'.repeat(MAX_QUESTION_HEADER_LENGTH + 1);
    expect(
      questionTextOf({
        questions: [
          { question: 'a', header: '' },
          { question: 'b', header: oversized },
          { question: 'c', header: 42 },
          { question: 'd', multiSelect: 'yes' },
        ],
      }),
    ).toBe('a\nb\nc\nd');
    // The largest header that still fits IS kept — the bound is inclusive.
    const atLimit = 'h'.repeat(MAX_QUESTION_HEADER_LENGTH);
    expect(
      questionTextOf({ questions: [{ question: 'e', header: atLimit }] }),
    ).toBe(`[${atLimit}] e`);
  });

  it('flattens every offered option label across questions', () => {
    expect(optionLabelsOf(INPUT)).toEqual(['Red', 'Blue', 'Yes']);
  });

  it('degrades malformed payloads to EMPTY projections instead of throwing', () => {
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
      expect(questionTextOf(bad)).toBe('');
      expect(optionLabelsOf(bad)).toEqual([]);
    }
  });

  it('keeps the entries that parse and drops the parts that do not', () => {
    expect(questionTextOf({ questions: [{ question: 'ok' }] })).toBe('ok');
    expect(optionLabelsOf({ questions: [{ question: 'ok' }] })).toEqual([]);
    // A non-array options field is dropped while its question survives.
    const mixed = { questions: [{ question: 'ok', options: 'nope' }] };
    expect(questionTextOf(mixed)).toBe('ok');
    expect(optionLabelsOf(mixed)).toEqual([]);
    expect(
      optionLabelsOf({
        questions: [{ question: 'ok', options: [{ label: 'A' }, { bad: 1 }] }],
      }),
    ).toEqual(['A']);
  });

  it('drops empty and oversized option labels (TWIN PARSER rule mirrored from the renderer card)', () => {
    // An empty label is unanswerable, and an oversized one offers an answer
    // the daemon's own answer channel (MAX_ANSWER_LENGTH gate) would reject.
    const labels = optionLabelsOf({
      questions: [
        {
          question: 'pick',
          options: [
            { label: '' },
            { label: 'ok' },
            { label: 'x'.repeat(MAX_ANSWER_LENGTH) },
            { label: 'x'.repeat(MAX_ANSWER_LENGTH + 1) },
          ],
        },
      ],
    });
    expect(labels).toEqual(['ok', 'x'.repeat(MAX_ANSWER_LENGTH)]);
  });

  it('withResponse folds the answer into the tool input as `response`', () => {
    expect(withResponse(INPUT, 'Blue')).toEqual({
      ...INPUT,
      response: 'Blue',
    });
    // Non-object inputs still produce a schema-shaped answer carrier.
    expect(withResponse(null, 'x')).toEqual({ response: 'x' });
    expect(withResponse('junk', 'x')).toEqual({ response: 'x' });
  });
});
