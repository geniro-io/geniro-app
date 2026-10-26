import { describe, expect, it } from 'vitest';

import {
  readPendingQuestion,
  serializePendingQuestion,
} from './pending-question';

describe('pending question snapshots', () => {
  const SNAPSHOT = {
    kind: 'question' as const,
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
      kind: 'question',
      requestId: 'req-1',
      title: null,
      questions: [
        {
          question: 'Which database?',
          options: [{ label: 'Postgres' }, { nope: true }],
        },
      ],
    });

    const read = readPendingQuestion(stored);
    const questions = read?.kind === 'question' ? read.questions : [];
    expect(questions[0]?.options).toEqual([{ label: 'Postgres' }]);
  });

  it('round-trips a plan and a patch in the same column', () => {
    const plan = {
      kind: 'plan' as const,
      requestId: 'req-plan',
      title: 'Make the queue test deterministic',
      steps: [{ title: 'Replace the sleep', detail: 'wait for the queue' }],
    };
    const patch = {
      kind: 'patch' as const,
      requestId: 'req-patch',
      fingerprint: null,
      patch: {
        filePath: 'a.ts',
        oldString: 'const timeout = 30;',
        newString: 'const timeout = 60;',
        summary: 'Raise the timeout',
      },
    };

    expect(readPendingQuestion(serializePendingQuestion(plan))).toEqual(plan);
    expect(readPendingQuestion(serializePendingQuestion(patch))).toEqual(patch);
  });

  it('writes a question with its kind, so every row names what it is', () => {
    expect(JSON.parse(serializePendingQuestion(SNAPSHOT))).toMatchObject({
      kind: 'question',
    });
  });

  it.each(['absent' as const, { sha256: 'a'.repeat(64) }, null])(
    'round-trips a patch fingerprint %j',
    (fingerprint) => {
      const snapshot = {
        kind: 'patch' as const,
        requestId: 'req-patch',
        patch: { filePath: 'a.ts', newString: 'replacement' },
        fingerprint,
      };
      expect(readPendingQuestion(serializePendingQuestion(snapshot))).toEqual(
        snapshot,
      );
    },
  );

  it.each([undefined, {}, { sha256: 'not a hash' }, 42])(
    'refuses an unreadable patch fingerprint %j',
    (fingerprint) => {
      expect(
        readPendingQuestion(
          JSON.stringify({
            kind: 'patch',
            requestId: 'req-patch',
            file_path: 'a.ts',
            new_string: 'replacement',
            fingerprint,
          }),
        ),
      ).toBeNull();
    },
  );

  it.each([
    [
      'a question from an older build that names no kind',
      JSON.stringify({
        requestId: 'req-1',
        title: null,
        questions: SNAPSHOT.questions,
      }),
    ],
    ['an empty column', ''],
    ['a null column', null],
    ['text that is not JSON', '{not json'],
    ['JSON that is not an object', '"hello"'],
    ['a snapshot with no request id', '{"kind":"question","questions":[]}'],
    [
      'a snapshot whose questions read as nothing',
      '{"kind":"question","requestId":"req-1","questions":[{"question":"?"}]}',
    ],
    [
      'a card whose kind is not one this build writes',
      JSON.stringify({
        kind: 'poll',
        requestId: 'req-1',
        title: null,
        questions: SNAPSHOT.questions,
      }),
    ],
    [
      'a plan with no readable step',
      '{"kind":"plan","requestId":"req-1","title":"T","steps":[]}',
    ],
    [
      'a patch over the size the live reader refuses',
      `{"kind":"patch","requestId":"req-1","fingerprint":null,"file_path":"a.ts","new_string":"${'x'.repeat(200_001)}"}`,
    ],
  ])('answers null for %s', (_name, stored) => {
    // The column is TEXT that outlives the process that wrote it, so a row from
    // an older build or a database browser must cost the card rather than the
    // boot — the rehydration clears exactly what this refuses.
    expect(readPendingQuestion(stored)).toBeNull();
  });
});
