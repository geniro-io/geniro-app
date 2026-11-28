import { describe, expect, it } from 'vitest';

import {
  PIN_QUESTION_MIN_COLUMN_PX,
  placeOpenQuestions,
  type QuestionPlacement,
} from './question-placement';

const LOW = PIN_QUESTION_MIN_COLUMN_PX - 1;
const TALL = PIN_QUESTION_MIN_COLUMN_PX;
const NONE: ReadonlyMap<string, QuestionPlacement> = new Map();

describe('placeOpenQuestions', () => {
  it('puts a drawn question in the feed on a column under the threshold', () => {
    const placed = placeOpenQuestions(NONE, ['q1'], new Set(['q1']), LOW, true);
    expect(placed.get('q1')).toBe('feed');
  });

  it('pins a drawn question on a column at the threshold or taller', () => {
    const placed = placeOpenQuestions(
      NONE,
      ['q1'],
      new Set(['q1']),
      TALL,
      true,
    );
    expect(placed.get('q1')).toBe('pinned');
  });

  it('pins a question whose row is not drawn, however low the column', () => {
    const placed = placeOpenQuestions(NONE, ['q1'], new Set(), LOW, true);
    expect(placed.get('q1')).toBe('pinned');
  });

  it('decides nothing before the column is measured', () => {
    const placed = placeOpenQuestions(NONE, ['q1'], new Set(['q1']), 0, true);
    expect(placed.has('q1')).toBe(false);
  });

  it('keeps a question where it was when the column crosses the threshold', () => {
    const inFeed = placeOpenQuestions(NONE, ['q1'], new Set(['q1']), LOW, true);
    expect(
      placeOpenQuestions(inFeed, ['q1'], new Set(['q1']), TALL, true).get('q1'),
    ).toBe('feed');
    const pinned = placeOpenQuestions(
      NONE,
      ['q2'],
      new Set(['q2']),
      TALL,
      true,
    );
    expect(
      placeOpenQuestions(pinned, ['q2'], new Set(['q2']), LOW, true).get('q2'),
    ).toBe('pinned');
  });

  it('pins a feed question whose row leaves the drawn window', () => {
    const inFeed = placeOpenQuestions(NONE, ['q1'], new Set(['q1']), LOW, true);
    expect(
      placeOpenQuestions(inFeed, ['q1'], new Set(), LOW, true).get('q1'),
    ).toBe('pinned');
  });

  it('moves and decides nothing while the thread is opening', () => {
    const inFeed = placeOpenQuestions(NONE, ['q1'], new Set(['q1']), LOW, true);
    expect(placeOpenQuestions(inFeed, ['q1', 'q2'], null, LOW, true)).toBe(
      inFeed,
    );
  });

  it('forgets a question once it is no longer open', () => {
    const placed = placeOpenQuestions(NONE, ['q1'], new Set(['q1']), LOW, true);
    expect(placeOpenQuestions(placed, [], new Set(), LOW, true).size).toBe(0);
  });

  it('pins every question at once off a touch device, however low the column', () => {
    expect(
      placeOpenQuestions(NONE, ['q1'], new Set(['q1']), LOW, false).get('q1'),
    ).toBe('pinned');
    expect(
      placeOpenQuestions(NONE, ['q1'], new Set(['q1']), 0, false).get('q1'),
    ).toBe('pinned');
  });

  it('hands back the same map when nothing changed', () => {
    const placed = placeOpenQuestions(NONE, ['q1'], new Set(['q1']), LOW, true);
    expect(placeOpenQuestions(placed, ['q1'], new Set(['q1']), LOW, true)).toBe(
      placed,
    );
  });
});
