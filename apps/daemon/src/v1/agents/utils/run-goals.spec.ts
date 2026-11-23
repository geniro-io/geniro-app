import { describe, expect, it } from 'vitest';

import type { GoalStatus, ThreadOutcomeKind } from '../chat.types';
import {
  outcomeDivergesFromGoals,
  outcomeKindFromGoals,
  threadOutcomeOf,
} from './run-goals';

const goals = (...statuses: GoalStatus[]) =>
  statuses.map((status) => ({ status }));

describe('outcomeKindFromGoals', () => {
  it('reads all achieved as success, some as partial, none as failed', () => {
    expect(outcomeKindFromGoals(goals('achieved', 'achieved'))).toBe('success');
    expect(outcomeKindFromGoals(goals('achieved', 'not_achieved'))).toBe(
      'partial',
    );
    expect(outcomeKindFromGoals(goals('not_achieved', 'not_achieved'))).toBe(
      'failed',
    );
  });

  it('gives no outcome while a goal is open, and leaves dropped ones out', () => {
    expect(outcomeKindFromGoals(goals('achieved', 'open'))).toBeNull();
    expect(outcomeKindFromGoals(goals('not_achieved', 'open'))).toBeNull();
    expect(outcomeKindFromGoals(goals('achieved', 'dropped'))).toBe('success');
  });

  it('has no outcome without a counted goal', () => {
    expect(outcomeKindFromGoals([])).toBeNull();
    expect(outcomeKindFromGoals(goals('dropped'))).toBeNull();
  });
});

const recordedAs = (kind: ThreadOutcomeKind) => ({
  kind,
  summary: 'done',
  source: 'recorded' as const,
  seq: 9,
});

describe('threadOutcomeOf', () => {
  it('prefers the recorded outcome over the goals', () => {
    expect(threadOutcomeOf(recordedAs('abandoned'), goals('achieved'))).toEqual(
      { ...recordedAs('abandoned'), divergesFromGoals: false },
    );
    expect(threadOutcomeOf(null, goals('achieved'))).toEqual({
      kind: 'success',
      summary: null,
      source: 'goals',
      seq: null,
      divergesFromGoals: false,
    });
    expect(threadOutcomeOf(null, [])).toBeNull();
  });

  it('marks a recorded success that a goal not achieved or still open contradicts', () => {
    expect(
      threadOutcomeOf(recordedAs('success'), goals('achieved', 'not_achieved'))
        ?.divergesFromGoals,
    ).toBe(true);
    expect(
      threadOutcomeOf(recordedAs('success'), goals('achieved', 'open'))
        ?.divergesFromGoals,
    ).toBe(true);
  });

  it('does not mark a success the goals bear out, nor any other outcome', () => {
    expect(
      threadOutcomeOf(recordedAs('success'), goals('achieved', 'dropped'))
        ?.divergesFromGoals,
    ).toBe(false);
    expect(threadOutcomeOf(recordedAs('success'), [])?.divergesFromGoals).toBe(
      false,
    );
    expect(
      threadOutcomeOf(recordedAs('partial'), goals('not_achieved'))
        ?.divergesFromGoals,
    ).toBe(false);
    expect(
      threadOutcomeOf(null, goals('achieved', 'not_achieved'))
        ?.divergesFromGoals,
    ).toBe(false);
  });
});

describe('outcomeDivergesFromGoals', () => {
  it('never marks an outcome the goals derived', () => {
    expect(
      outcomeDivergesFromGoals(
        { kind: 'success', source: 'goals' },
        goals('not_achieved'),
      ),
    ).toBe(false);
  });
});
