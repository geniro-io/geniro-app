import { describe, expect, it } from 'vitest';

import {
  readPendingQuestion,
  serializePendingQuestion,
} from './pending-question';

describe('pending question snapshots', () => {
  const SNAPSHOT = {
    requestId: 'req-1',
    title: 'Pick a database',
    questions: [
      {
        question: 'Which database?',
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
      },
    ],
  };

  it('round-trips what re-tracking a standing card needs', () => {
    expect(readPendingQuestion(serializePendingQuestion(SNAPSHOT))).toEqual(
      SNAPSHOT,
    );
  });

  it('keeps a card that carried no title', () => {
    const untitled = { ...SNAPSHOT, title: null };

    expect(readPendingQuestion(serializePendingQuestion(untitled))).toEqual(
      untitled,
    );
  });

  it('normalizes the stored questions rather than trusting them', () => {
    // One normalizer for the live path and this one, so a snapshot can never
    // carry a shape the ask itself would have refused. Here: an option with no
    // label, which `readHostQuestions` drops.
    const stored = JSON.stringify({
      requestId: 'req-1',
      title: null,
      questions: [
        {
          question: 'Which database?',
          options: [{ label: 'Postgres' }, { nope: true }],
        },
      ],
    });

    expect(readPendingQuestion(stored)?.questions[0]?.options).toEqual([
      { label: 'Postgres' },
    ]);
  });

  it.each([
    ['an empty column', ''],
    ['a null column', null],
    ['text that is not JSON', '{not json'],
    ['JSON that is not an object', '"hello"'],
    ['a snapshot with no request id', '{"questions":[]}'],
    [
      'a snapshot whose questions read as nothing',
      '{"requestId":"req-1","questions":[{"question":"?"}]}',
    ],
  ])('answers null for %s', (_name, stored) => {
    // The column is TEXT that outlives the process that wrote it, so a row from
    // an older build or a database browser must cost the card rather than the
    // boot — the rehydration clears exactly what this refuses.
    expect(readPendingQuestion(stored)).toBeNull();
  });
});
