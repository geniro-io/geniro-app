import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import type { GoalDao } from '../../agents/dao/goal.dao';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { LessonSignalGoal } from './lesson-signals.fold';
import { readLessonSignals } from './read-lesson-signals';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 12, minute));

function sources(rows: number, goals: LessonSignalGoal[]) {
  const items = Array.from({ length: rows }, (_, i) => ({
    seq: i + 1,
    kind: 'turn_complete',
    role: null,
    payload: '{}',
    createdAt: at(i + 1),
  }));
  const itemDao = {
    analysisPage: (
      _runId: string,
      page: {
        afterSeq: number;
        maxSeq: number;
        limit: number;
        kinds?: readonly string[];
      },
    ) =>
      Promise.resolve(
        items
          .filter(
            (item) =>
              item.seq > page.afterSeq &&
              item.seq <= page.maxSeq &&
              (page.kinds === undefined || page.kinds.includes(item.kind)),
          )
          .slice(0, page.limit),
      ),
  };
  const goalDao = { listByRun: () => Promise.resolve(goals) };
  return {
    itemDao: itemDao as unknown as ItemDao,
    goalDao: goalDao as unknown as GoalDao,
  };
}

function goal(number: number, closedMinute: number): LessonSignalGoal {
  return {
    number,
    text: `goal ${number}`,
    status: 'not_achieved',
    evidence: null,
    closedAt: new Date(at(closedMinute).getTime()),
  };
}

const em = {} as EntityManager;

describe('readLessonSignals', () => {
  it('keeps to a later stretch only the goals closed between its rows and the row after it', async () => {
    const signals = await readLessonSignals(
      sources(6, [goal(1, 1), goal(2, 3), goal(3, 4.5), goal(4, 5)]),
      'run-1',
      2,
      4,
      em,
    );

    expect(signals).toEqual([
      { kind: 'goal_unmet', seq: 3, excerpt: 'not_achieved g2: goal 2' },
      { kind: 'goal_unmet', seq: 4, excerpt: 'not_achieved g3: goal 3' },
    ]);
  });

  it('takes a goal closed after the newest row into the stretch that ends on it', async () => {
    const signals = await readLessonSignals(
      sources(4, [goal(1, 9)]),
      'run-1',
      -1,
      4,
      em,
    );

    expect(signals).toEqual([
      { kind: 'goal_unmet', seq: 4, excerpt: 'not_achieved g1: goal 1' },
    ]);
  });
});
