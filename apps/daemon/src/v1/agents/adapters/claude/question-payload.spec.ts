import { describe, expect, it } from 'vitest';

import {
  optionLabelsOf,
  questionTextOf,
  withResponse,
} from './question-payload';

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

describe('question-payload projections', () => {
  it('projects the question text (multi-question inputs join per line)', () => {
    expect(questionTextOf(INPUT)).toBe('Which color?\nDeploy now?');
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
