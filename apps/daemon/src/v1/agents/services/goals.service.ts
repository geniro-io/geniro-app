import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { Goal } from '../../runs/entity/goal.entity';
import {
  type GoalActor,
  type GoalClosingStatus,
  type GoalDraft,
  type GoalRefusalCode,
  GOALS_PER_RUN,
  type GoalsWriteOutcome,
  type RunGoal,
  SINGLE_AGENT_NODE,
} from '../chat.types';
import { GoalDao } from '../dao/goal.dao';
import { RunDao } from '../dao/run.dao';
import { KeyedChain } from '../utils/keyed-chain';
import {
  readThreadOutcome,
  threadOutcomeOf,
  writeRunGoals,
} from '../utils/run-goals';
import { AgentEventBus } from './agent-events.bus';

/**
 * A run's goals: what its task is meant to achieve, recorded at the start by
 * the `goals` tool or by the user, and each closed with the evidence of how it
 * ended. `run_goals` is the record and outlives the run; after every write the
 * run's `goals` column is rewritten for its wire projection and the whole list
 * is announced on `run_status`.
 *
 * Writes of one run are serialized, so a goal's number is one past the run's
 * highest and the per-run cap holds under racing writers.
 */
@Injectable()
export class GoalsService implements OnModuleInit {
  private readonly logger = new Logger(GoalsService.name);
  private readonly writes = new KeyedChain();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly goalDao: GoalDao,
    private readonly bus: AgentEventBus,
  ) {}

  onModuleInit(): void {
    this.bus.allDeleted().subscribe((runId) => {
      this.writes.forget(runId);
    });
  }

  async list(runId: string): Promise<RunGoal[] | null> {
    const em = this.em.fork();
    if ((await this.runDao.getById(runId, em)) === null) {
      return null;
    }
    return (await this.goalDao.listByRun(runId, em)).map(toWire);
  }

  async isTeamRun(runId: string): Promise<boolean> {
    const run = await this.runDao.getById(runId, this.em.fork());
    return run !== null && run.teamId !== null;
  }

  /** Replace the run's open goals with these; closed goals stay. */
  set(
    runId: string,
    actor: GoalActor,
    drafts: readonly GoalDraft[],
  ): Promise<GoalsWriteOutcome> {
    return this.write(runId, async (goals, em, run) => {
      const open = goals.filter((goal) => goal.status === 'open');
      if (goals.length - open.length + drafts.length > GOALS_PER_RUN) {
        return tooMany();
      }
      const removedAt = new Date();
      for (const goal of open) {
        goal.deletedAt = removedAt;
      }
      let number = (await this.goalDao.highestNumber(run.id, em)) + 1;
      const added = drafts.map((draft) =>
        this.newGoal(em, run, actor, draft, number++),
      );
      await em.flush();
      return added;
    });
  }

  add(
    runId: string,
    actor: GoalActor,
    drafts: readonly GoalDraft[],
  ): Promise<GoalsWriteOutcome> {
    return this.write(runId, async (goals, em, run) => {
      if (goals.length + drafts.length > GOALS_PER_RUN) {
        return tooMany();
      }
      let number = (await this.goalDao.highestNumber(run.id, em)) + 1;
      const added = drafts.map((draft) =>
        this.newGoal(em, run, actor, draft, number++),
      );
      await em.flush();
      return added;
    });
  }

  update(
    runId: string,
    actor: GoalActor,
    id: string,
    text: string,
  ): Promise<GoalsWriteOutcome> {
    return this.write(runId, async (goals, em) => {
      const goal = find(goals, id);
      if (goal === null) {
        return notFound(id);
      }
      if (actor.kind === 'agent' && goal.status !== 'open') {
        return refuse(
          'GOAL_CLOSED',
          `${id} is already closed (${goal.status}); its wording stays as it was closed — reopen it first`,
        );
      }
      goal.text = text;
      goal.memberId = memberOf(actor);
      await em.flush();
      return [goal];
    });
  }

  /** Take an open goal off the list, as if it was never set. */
  remove(
    runId: string,
    actor: GoalActor,
    id: string,
  ): Promise<GoalsWriteOutcome> {
    return this.write(runId, async (goals, em) => {
      const goal = find(goals, id);
      if (goal === null) {
        return notFound(id);
      }
      if (goal.status !== 'open') {
        return refuse(
          'GOAL_CLOSED',
          `${id} is already closed (${goal.status}) — a closed goal stays on the record; reopen it first`,
        );
      }
      goal.deletedAt = new Date();
      await em.flush();
      return [];
    });
  }

  close(
    runId: string,
    actor: GoalActor,
    id: string,
    status: GoalClosingStatus,
    evidence: string,
  ): Promise<GoalsWriteOutcome> {
    return this.write(runId, async (goals, em) => {
      const goal = find(goals, id);
      if (goal === null) {
        return notFound(id);
      }
      if (goal.status !== 'open') {
        return refuse(
          'GOAL_CLOSED',
          `${id} is already closed (${goal.status}); reopen it to close it again`,
        );
      }
      goal.status = status;
      goal.evidence = evidence;
      goal.closedAt = new Date();
      goal.memberId = memberOf(actor);
      await em.flush();
      return [goal];
    });
  }

  reopen(
    runId: string,
    actor: GoalActor,
    id: string,
  ): Promise<GoalsWriteOutcome> {
    return this.write(runId, async (goals, em) => {
      const goal = find(goals, id);
      if (goal === null) {
        return notFound(id);
      }
      if (goal.status === 'open') {
        return refuse('GOAL_OPEN', `${id} is open already`);
      }
      goal.status = 'open';
      goal.evidence = null;
      goal.closedAt = null;
      goal.memberId = memberOf(actor);
      await em.flush();
      return [goal];
    });
  }

  private newGoal(
    em: EntityManager,
    run: { id: string; teamId: string | null },
    actor: GoalActor,
    draft: GoalDraft,
    number: number,
  ): Goal {
    const goal = em.create(
      Goal,
      {
        runId: run.id,
        number,
        teamSlug: run.teamId,
        memberId: memberOf(actor),
        text: draft.text,
        source: draft.source,
        status: 'open',
        evidence: null,
        closedAt: null,
      },
      { partial: true },
    );
    em.persist(goal);
    return goal;
  }

  private write(
    runId: string,
    change: (
      goals: Goal[],
      em: EntityManager,
      run: { id: string; teamId: string | null },
    ) => Promise<Goal[] | Refusal>,
  ): Promise<GoalsWriteOutcome> {
    return this.writes.run(runId, async () => {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (run === null) {
        return refuse('RUN_NOT_FOUND', 'this run no longer exists');
      }
      const changed = await change(
        await this.goalDao.listByRun(runId, em),
        em,
        run,
      );
      if ('code' in changed) {
        return { status: 'refused', ...changed };
      }
      const goals = (await this.goalDao.listByRun(runId, em)).map(toWire);
      await this.project(runId, goals, em);
      return { status: 'ok', goals, changed: changed.map(toWire) };
    });
  }

  /**
   * Keep the run's column and every client in step with the table. The table
   * is the record, so a failure here is logged and never refuses the write.
   */
  private async project(
    runId: string,
    goals: RunGoal[],
    em: EntityManager,
  ): Promise<void> {
    try {
      await this.runDao.updateWithoutActivity(
        runId,
        { goals: writeRunGoals(goals) },
        em,
      );
    } catch (err) {
      this.logger.warn(
        `run ${runId} recorded its goals but could not update its goals column: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Read now, not with the write: `record_outcome` writes the column on its
    // own chain, and an outcome read before it would be announced over it.
    const recorded = await this.runDao.threadOutcomeOf(runId, this.em.fork());
    this.bus.publishRunStatus({
      runId,
      status: null,
      goals,
      outcome: threadOutcomeOf(readThreadOutcome(recorded), goals),
    });
  }
}

interface Refusal {
  code: GoalRefusalCode;
  reason: string;
}

export function goalIdOf(number: number): string {
  return `g${number}`;
}

function toWire(goal: Goal): RunGoal {
  return {
    id: goalIdOf(goal.number),
    text: goal.text,
    source: goal.source,
    status: goal.status,
    evidence: goal.evidence,
    memberId: goal.memberId,
    createdAt: goal.createdAt.toISOString(),
    closedAt: goal.closedAt?.toISOString() ?? null,
  };
}

function find(goals: readonly Goal[], id: string): Goal | null {
  const match = /^g(\d+)$/i.exec(id.trim());
  const number = match === null ? null : Number(match[1]);
  return goals.find((goal) => goal.number === number) ?? null;
}

function memberOf(actor: GoalActor): string | null {
  return actor.kind === 'agent' && actor.memberId !== SINGLE_AGENT_NODE
    ? actor.memberId
    : null;
}

function refuse(
  code: GoalRefusalCode,
  reason: string,
): Refusal & {
  status: 'refused';
} {
  return { status: 'refused', code, reason };
}

function notFound(id: string): Refusal {
  return { code: 'GOAL_NOT_FOUND', reason: `this run has no goal ${id}` };
}

function tooMany(): Refusal {
  return {
    code: 'TOO_MANY_GOALS',
    reason: `a run holds at most ${GOALS_PER_RUN} goals; close or remove some, or keep the list to the few that decide whether the task is done`,
  };
}
