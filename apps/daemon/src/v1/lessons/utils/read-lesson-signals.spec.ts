import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import type { GoalStatus } from '../../agents/chat.types';
import { GoalDao } from '../../agents/dao/goal.dao';
import { ItemDao } from '../../agents/dao/item.dao';
import { Goal } from '../../runs/entity/goal.entity';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind } from '../../runs/runs.types';
import { readLessonSignals } from './read-lesson-signals';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 12, minute));

describe('readLessonSignals (in-memory sqlite)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, Goal],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
        schemaGenerator: mikroOrmConfig.schemaGenerator,
      }),
    );
    await orm.schema.update({ safe: true });
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
  });

  async function rows(...entries: [number, ItemKind][]): Promise<void> {
    const fork = orm.em.fork();
    for (const [seq, kind] of entries) {
      fork.create(Item, {
        runId: 'run-1',
        seq,
        kind,
        payload: '{}',
        createdAt: at(seq),
        updatedAt: at(seq),
      });
    }
    await fork.flush();
  }

  async function closedGoal(
    number: number,
    status: GoalStatus,
    closedMinute: number,
  ): Promise<void> {
    const fork = orm.em.fork();
    fork.persist(
      Object.assign(new Goal(), {
        runId: 'run-1',
        number,
        text: `goal ${number}`,
        source: 'agent',
        status,
        evidence: null,
        closedAt: at(closedMinute),
      }),
    );
    await fork.flush();
  }

  function read(afterSeq: number, maxSeq: number) {
    const em = orm.em.fork();
    return readLessonSignals(
      { itemDao: new ItemDao(em), goalDao: new GoalDao(em) },
      'run-1',
      afterSeq,
      maxSeq,
      em,
    );
  }

  it('places a goal on the newest row of any kind written by its close, a sub-agent row included', async () => {
    await rows(
      [1, 'message'],
      [2, 'turn_complete'],
      [3, 'subagent_info'],
      [4, 'shell_open'],
      [5, 'turn_complete'],
    );
    await closedGoal(1, 'not_achieved', 4);

    expect(await read(-1, 5)).toEqual([
      { kind: 'goal_unmet', seq: 4, excerpt: 'not_achieved g1: goal 1' },
    ]);
  });

  it('keeps a goal a later stretch closed before its first row of the kinds the fold reads', async () => {
    await rows(
      [1, 'turn_complete'],
      [2, 'turn_complete'],
      [3, 'subagent_info'],
      [4, 'task_list'],
      [5, 'turn_complete'],
    );
    await closedGoal(1, 'dropped', 3);

    expect(await read(2, 5)).toEqual([
      { kind: 'goal_unmet', seq: 3, excerpt: 'dropped g1: goal 1' },
    ]);
  });

  it('leaves to other stretches a goal closed before its first row or once the row after it was written', async () => {
    await rows(
      [1, 'turn_complete'],
      [2, 'turn_complete'],
      [3, 'turn_complete'],
      [4, 'turn_complete'],
      [5, 'turn_complete'],
      [6, 'turn_complete'],
    );
    await closedGoal(1, 'not_achieved', 1);
    await closedGoal(2, 'not_achieved', 3);
    await closedGoal(3, 'not_achieved', 5);
    await closedGoal(4, 'achieved', 3);

    expect(await read(2, 4)).toEqual([
      { kind: 'goal_unmet', seq: 3, excerpt: 'not_achieved g2: goal 2' },
    ]);
  });

  it('takes into the stretch that opens the thread a goal closed before its first row, and one closed after its newest row', async () => {
    await rows([2, 'message'], [3, 'turn_complete']);
    await closedGoal(1, 'not_achieved', 1);
    await closedGoal(2, 'dropped', 9);

    expect(await read(-1, 3)).toEqual([
      { kind: 'goal_unmet', seq: 2, excerpt: 'not_achieved g1: goal 1' },
      { kind: 'goal_unmet', seq: 3, excerpt: 'dropped g2: goal 2' },
    ]);
  });
});
