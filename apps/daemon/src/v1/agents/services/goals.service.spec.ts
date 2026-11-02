import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Run } from '../../runs/entity/run.entity';
import { goalsDb } from '../__tests__/goals-db';
import { GOALS_PER_RUN, type GoalsWriteOutcome } from '../chat.types';
import { RunDao } from '../dao/run.dao';
import { readRunGoals } from '../utils/run-goals';

type Db = Awaited<ReturnType<typeof goalsDb>>;

function ok(outcome: GoalsWriteOutcome) {
  if (outcome.status !== 'ok') {
    throw new Error(`refused: ${outcome.code} ${outcome.reason}`);
  }
  return outcome;
}

describe('GoalsService', () => {
  let db: Db;
  const agent = { kind: 'agent', memberId: 'dev' } as const;

  beforeEach(async () => {
    db = await goalsDb();
    await db.seedRun('run-1', { teamId: 'dev-team' });
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  it('numbers goals, stamps the team and the member, and keeps them in the run column', async () => {
    const written = ok(
      await db.service.set('run-1', agent, [
        { text: 'export saves a csv', source: 'user' },
        { text: 'spec passes', source: 'agent' },
      ]),
    );

    expect(written.goals.map((goal) => [goal.id, goal.status])).toEqual([
      ['g1', 'open'],
      ['g2', 'open'],
    ]);
    expect(written.goals[0]).toMatchObject({ memberId: 'dev', source: 'user' });
    const run = await new RunDao(db.em).getById('run-1', db.em.fork());
    expect(readRunGoals(run!.goals).map((goal) => goal.id)).toEqual([
      'g1',
      'g2',
    ]);
    expect(db.announced.at(-1)).toMatchObject({
      runId: 'run-1',
      goals: written.goals,
      outcome: null,
    });
    ok(await db.service.close('run-1', agent, 'g1', 'achieved', 'saved'));
    ok(await db.service.close('run-1', agent, 'g2', 'not_achieved', 'red'));
    expect(db.announced.at(-1)?.outcome).toMatchObject({
      kind: 'partial',
      source: 'goals',
    });
  });

  it('replaces only the open goals on set, and never reuses a closed goal’s number', async () => {
    ok(
      await db.service.set('run-1', agent, [
        { text: 'a', source: 'agent' },
        { text: 'b', source: 'agent' },
      ]),
    );
    ok(await db.service.close('run-1', agent, 'g2', 'achieved', 'ran it'));

    const reset = ok(
      await db.service.set('run-1', agent, [{ text: 'c', source: 'agent' }]),
    );

    expect(
      reset.goals.map((goal) => [goal.id, goal.text, goal.status]),
    ).toEqual([
      ['g2', 'b', 'achieved'],
      ['g3', 'c', 'open'],
    ]);
  });

  it('closes with evidence, refuses a second close, and reopens', async () => {
    ok(await db.service.add('run-1', agent, [{ text: 'a', source: 'agent' }]));

    const closed = ok(
      await db.service.close('run-1', agent, 'g1', 'not_achieved', 'flaky'),
    );
    expect(closed.changed[0]).toMatchObject({
      status: 'not_achieved',
      evidence: 'flaky',
    });
    expect(closed.changed[0]!.closedAt).not.toBeNull();

    expect(
      await db.service.close('run-1', agent, 'g1', 'achieved', 'again'),
    ).toMatchObject({ status: 'refused', code: 'GOAL_CLOSED' });
    expect(await db.service.remove('run-1', agent, 'g1')).toMatchObject({
      status: 'refused',
      code: 'GOAL_CLOSED',
    });

    const reopened = ok(
      await db.service.reopen('run-1', { kind: 'user' }, 'g1'),
    );
    expect(reopened.changed[0]).toMatchObject({
      status: 'open',
      evidence: null,
      closedAt: null,
      memberId: null,
    });
  });

  it('never hands a removed goal’s number out again', async () => {
    ok(
      await db.service.add('run-1', agent, [
        { text: 'a', source: 'agent' },
        { text: 'b', source: 'agent' },
      ]),
    );
    ok(await db.service.remove('run-1', agent, 'g2'));

    const added = ok(
      await db.service.add('run-1', agent, [{ text: 'c', source: 'agent' }]),
    );

    expect(added.goals.map((goal) => goal.id)).toEqual(['g1', 'g3']);
  });

  it('lets the user, never an agent, reword a closed goal', async () => {
    ok(await db.service.add('run-1', agent, [{ text: 'a', source: 'agent' }]));
    ok(await db.service.close('run-1', agent, 'g1', 'achieved', 'done'));

    expect(await db.service.update('run-1', agent, 'g1', 'b')).toMatchObject({
      status: 'refused',
      code: 'GOAL_CLOSED',
    });
    expect(
      ok(await db.service.update('run-1', { kind: 'user' }, 'g1', 'b'))
        .goals[0],
    ).toMatchObject({ text: 'b', status: 'achieved' });
  });

  it('announces the outcome recorded meanwhile, not one derived from the goals', async () => {
    ok(await db.service.add('run-1', agent, [{ text: 'a', source: 'agent' }]));
    await new RunDao(db.em).updateWithoutActivity(
      'run-1',
      {
        threadOutcome: JSON.stringify({
          kind: 'abandoned',
          summary: 'called off',
          source: 'recorded',
          seq: 9,
        }),
      },
      db.em.fork(),
    );

    ok(await db.service.close('run-1', agent, 'g1', 'achieved', 'done'));

    expect(db.announced.at(-1)?.outcome).toMatchObject({
      kind: 'abandoned',
      source: 'recorded',
    });
  });

  it('refuses an unknown goal, a run that is gone, and a list past the cap', async () => {
    expect(await db.service.update('run-1', agent, 'g9', 'x')).toMatchObject({
      status: 'refused',
      code: 'GOAL_NOT_FOUND',
    });
    expect(
      await db.service.add('gone', agent, [{ text: 'x', source: 'agent' }]),
    ).toMatchObject({ status: 'refused', code: 'RUN_NOT_FOUND' });
    const many = Array.from({ length: GOALS_PER_RUN + 1 }, (_, i) => ({
      text: `goal ${i}`,
      source: 'agent' as const,
    }));
    expect(await db.service.add('run-1', agent, many)).toMatchObject({
      status: 'refused',
      code: 'TOO_MANY_GOALS',
    });
  });

  it('files a chat agent’s goals under no member', async () => {
    await db.seedRun('chat-1');
    const written = ok(
      await db.service.add('chat-1', { kind: 'agent', memberId: 'agent' }, [
        { text: 'a', source: 'agent' },
      ]),
    );
    expect(written.goals[0]!.memberId).toBeNull();
  });

  it('keeps the goals after the run row is gone', async () => {
    ok(await db.service.add('run-1', agent, [{ text: 'a', source: 'agent' }]));
    const fork = db.em.fork();
    await fork.nativeDelete(Run, { id: 'run-1' });

    const rows = await db.em
      .fork()
      .getKysely<{ run_goals: { run_id: string } }>()
      .selectFrom('run_goals')
      .select('run_id')
      .execute();
    expect(rows).toEqual([{ run_id: 'run-1' }]);
  });
});
