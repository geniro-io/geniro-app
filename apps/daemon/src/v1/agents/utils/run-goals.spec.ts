import { describe, expect, it } from 'vitest';

import type { GoalStatus } from '../chat.types';
import { outcomeKindFromGoals, threadOutcomeOf } from './run-goals';

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

describe('threadOutcomeOf', () => {
  it('prefers the recorded outcome over the goals', () => {
    const recorded = {
      kind: 'abandoned' as const,
      summary: 'called off',
      source: 'recorded' as const,
      seq: 9,
    };
    expect(threadOutcomeOf(recorded, goals('achieved'))).toBe(recorded);
    expect(threadOutcomeOf(null, goals('achieved'))).toEqual({
      kind: 'success',
      summary: null,
      source: 'goals',
      seq: null,
    });
    expect(threadOutcomeOf(null, [])).toBeNull();
  });
});
