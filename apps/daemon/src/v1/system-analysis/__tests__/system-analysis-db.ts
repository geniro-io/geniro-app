import { randomUUID } from 'node:crypto';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import type { AgentFlagCost, ThreadOutcomeKind } from '../../agents/chat.types';
import { LessonProposal } from '../../lessons/entity/lesson-proposal.entity';
import { Project } from '../../projects/entity/project.entity';
import { AgentFlag } from '../../runs/entity/agent-flag.entity';
import { Goal } from '../../runs/entity/goal.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { WallTurn } from '../../runs/entity/wall-turn.entity';
import { TeamRecommendation } from '../../stats/entity/team-recommendation.entity';
import { ToolCallEvent } from '../../stats/entity/tool-call-event.entity';
import { UsageActivity } from '../../stats/entity/usage-activity.entity';
import { UsageCounter } from '../../stats/entity/usage-counter.entity';
import { UsageCounterBackfill } from '../../stats/entity/usage-counter-backfill.entity';
import { UsageSubject } from '../../stats/entity/usage-subject.entity';
import { Task } from '../../tasks/entity/task.entity';

export async function systemAnalysisDb() {
  const orm = await MikroORM.init(
    defineConfig({
      ...GENIRO_ORM_RUNTIME,
      dbName: ':memory:',
      entities: [
        Run,
        Item,
        NodeState,
        WallTurn,
        AgentFlag,
        Goal,
        LessonProposal,
        ToolCallEvent,
        UsageActivity,
        UsageCounter,
        UsageSubject,
        UsageCounterBackfill,
        TeamRecommendation,
        Project,
        Task,
      ],
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
      schemaGenerator: mikroOrmConfig.schemaGenerator,
    }),
  );
  await orm.schema.update({ safe: true });

  const persistAll = async (rows: object[]): Promise<void> => {
    const fork = orm.em.fork();
    for (const row of rows) {
      fork.persist(row);
    }
    await fork.flush();
  };

  const seedRun = async (
    id: string,
    extra: Partial<Run> = {},
  ): Promise<void> => {
    await persistAll([
      Object.assign(new Run(), {
        id,
        status: 'completed',
        title: id,
        ...extra,
      }),
    ]);
  };

  const seedItem = async (
    runId: string,
    seq: number,
    createdAt: Date,
    extra: Partial<Item> = {},
  ): Promise<void> => {
    await persistAll([
      Object.assign(new Item(), {
        runId,
        seq,
        kind: 'message',
        role: 'assistant',
        payload: JSON.stringify({ text: 'hi' }),
        createdAt,
        updatedAt: createdAt,
        ...extra,
      }),
    ]);
  };

  const seedFlag = async (
    runId: string,
    cost: AgentFlagCost,
    occurredAt: Date,
    extra: Partial<AgentFlag> = {},
  ): Promise<void> => {
    await persistAll([
      Object.assign(new AgentFlag(), {
        handle: `F-${randomUUID().slice(0, 6)}`,
        runId,
        seq: 0,
        occurredAt,
        runKind: 'chat',
        cost,
        category: 'geniro_tool',
        summary: `flag on ${runId}`,
        ...extra,
      }),
    ]);
  };

  const seedToolCall = async (
    runId: string,
    occurredAt: Date,
    tool: string,
    mcpServer: string | null = null,
    seq = 0,
  ): Promise<void> => {
    await persistAll([
      Object.assign(new ToolCallEvent(), {
        runId,
        seq,
        occurredAt,
        tool,
        mcpServer,
        ok: false,
      }),
    ]);
  };

  const seedOutcome = async (
    runId: string,
    kind: ThreadOutcomeKind,
    occurredAt: Date,
  ): Promise<void> => {
    await persistAll([
      Object.assign(new UsageActivity(), {
        kind: 'thread_outcome',
        runId,
        occurredAt,
        dedupKey: `thread_outcome:${runId}:${randomUUID()}`,
        sourceSeq: 0,
        outcomeKind: kind,
      }),
    ]);
  };

  const seedGoal = async (
    runId: string,
    number: number,
    status: Goal['status'],
  ): Promise<void> => {
    await persistAll([
      Object.assign(new Goal(), {
        runId,
        number,
        text: `goal ${number}`,
        source: 'agent',
        status,
      }),
    ]);
  };

  const seedDroppedLesson = async (
    reflectionRunId: string,
    seq: number,
  ): Promise<void> => {
    await persistAll([
      Object.assign(new LessonProposal(), {
        sourceRunId: 'thread-of-lesson',
        reflectionRunId,
        segmentId: randomUUID(),
        title: 'Lesson',
        rule: 'Rule',
        why: 'Why',
        signalKind: 'user_correction',
        evidenceSeq: seq,
        evidenceQuote: 'quote',
        target: JSON.stringify({ kind: 'memory' }),
        dedup: randomUUID(),
        status: 'dropped_by_check',
      }),
    ]);
  };

  const seedProject = async (
    extra: Partial<Project> & Pick<Project, 'id'>,
  ): Promise<void> => {
    await persistAll([
      Object.assign(new Project(), {
        name: 'Geniro',
        folder: '/work/geniro',
        taskKey: 'GEN',
        ...extra,
      }),
    ]);
  };

  const seedTask = async (extra: Partial<Task>): Promise<void> => {
    await persistAll([
      Object.assign(new Task(), {
        title: 'Card',
        status: 'backlog',
        ...extra,
      }),
    ]);
  };

  return {
    orm,
    em: orm.em,
    persistAll,
    seedRun,
    seedItem,
    seedFlag,
    seedToolCall,
    seedOutcome,
    seedGoal,
    seedDroppedLesson,
    seedProject,
    seedTask,
    close: () => orm.close(true),
  };
}

export type SystemAnalysisDb = Awaited<ReturnType<typeof systemAnalysisDb>>;
