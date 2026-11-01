import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';

import {
  type StageActor,
  type StageChangePayload,
  StageChangePayloadSchema,
  type StageMoveAction,
  type StageProgress,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ItemCallIndexService } from '../../agents/services/item-call-index.service';
import { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import { MonitorRegistry } from '../../agents/services/monitor.registry';
import { RunWriteQueue } from '../../agents/services/run-write.queue';
import { parseJsonColumn } from '../../agents/utils/json-util';
import { persistItemAndEmit } from '../../agents/utils/persist-item';
import { readPersistedResetWakes } from '../../agents/utils/run-reset-wakes';
import {
  readRunStageProgress,
  writeRunStageProgress,
} from '../../agents/utils/stage-progress';
import type { Run } from '../../runs/entity/run.entity';
import type {
  StageMove,
  StageMoveRequest,
  StageMoveResult,
  StageRefusalCode,
  Team,
  TeamStage,
} from '../teams.types';
import { foldStages, stagesReopenResets } from '../utils/stage-fold';
import {
  MAX_AGENT_STAGE_TEXT_LINES,
  MAX_STAGE_TEXT_LENGTH,
} from '../utils/stage-text';
import { walkableStages } from '../utils/stage-validate';
import { triggerMemberId } from '../utils/team-roster';
import { RunTeamService } from './run-team.service';

export const STAGE_COLUMN_RETRY_MS = 30_000;

export interface RunStages {
  stages: readonly TeamStage[];
  progress: StageProgress;
  leadId: string | null;
}

@Injectable()
export class StageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StageService.name);
  private readonly registered = new Map<string, ReadonlySet<string>>();
  private readonly cache = new Map<string, RunStages>();
  private readonly unstaged = new Set<string>();
  private readonly unsynced = new Set<string>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly announcedRevs = new Map<string, number>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly seqs: ItemSeqAllocator,
    private readonly calls: ItemCallIndexService,
    private readonly bus: AgentEventBus,
    private readonly runTeams: RunTeamService,
    private readonly writes: RunWriteQueue,
    @Optional() private readonly monitors?: MonitorRegistry,
  ) {}

  onModuleInit(): void {
    this.bus.allDeleted().subscribe((runId) => {
      this.forget(runId);
    });
    this.bus.allChanged().subscribe((runs) => {
      for (const run of runs) {
        if (run.archivedAt !== null) {
          this.drop(run.id);
        }
      }
    });
  }

  register(runId: string, team: Team): void {
    if (walkableStages(team) === null) {
      this.registered.delete(runId);
      return;
    }
    this.registered.set(
      runId,
      new Set(team.members.map((member) => member.id)),
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.retries.values()) {
      clearTimeout(timer);
    }
    this.retries.clear();
  }

  forget(runId: string): void {
    this.registered.delete(runId);
    this.drop(runId);
    void this.writes.run(runId, async () => {
      this.drop(runId);
      this.generations.delete(runId);
      this.announcedRevs.delete(runId);
    });
  }

  generation(runId: string): number {
    return this.generations.get(runId) ?? 0;
  }

  private drop(runId: string): void {
    this.cache.delete(runId);
    this.unstaged.delete(runId);
    this.unsynced.delete(runId);
    clearTimeout(this.retries.get(runId));
    this.retries.delete(runId);
    this.generations.set(runId, this.generation(runId) + 1);
  }

  async isWaiting(runId: string): Promise<boolean> {
    const run = await this.runDao.getById(runId, this.em.fork());
    if (run === null || run.archivedAt !== null) {
      return true;
    }
    return (
      readPersistedResetWakes(run.resetWakes).length > 0 ||
      this.monitors?.isRunning(runId) === true
    );
  }

  canUse(runId: string, memberId: string): boolean {
    return this.registered.get(runId)?.has(memberId) ?? false;
  }

  async current(runId: string): Promise<RunStages | null> {
    const cached = this.cache.get(runId);
    if (cached !== undefined && !this.unsynced.has(runId)) {
      return cached;
    }
    if (cached === undefined && this.unstaged.has(runId)) {
      return null;
    }
    try {
      return await this.writes.run(runId, async () => {
        const again = this.cache.get(runId);
        if (again !== undefined) {
          if (this.unsynced.has(runId)) {
            await this.sync(runId, again.progress, this.em.fork());
          }
          return again;
        }
        const em = this.em.fork();
        const run = await this.runDao.getById(runId, em);
        const team = run === null ? null : await this.teamOf(run, em);
        const stages = team === null ? null : walkableStages(team);
        if (
          run !== null &&
          (run.teamId === null || (team !== null && stages === null))
        ) {
          this.unstaged.add(runId);
        }
        if (run === null || team === null || stages === null) {
          return null;
        }
        const progress = foldStages(stages, await this.movesOf(runId, em));
        if (readRunStageProgress(run.stageProgress)?.rev !== progress.rev) {
          await this.sync(runId, progress, em);
        }
        const loaded = {
          stages,
          progress,
          leadId: triggerMemberId(team),
        };
        if (run.archivedAt === null) {
          this.cache.set(runId, loaded);
        }
        return loaded;
      });
    } catch (error) {
      this.logger.warn(
        `run ${runId}: could not read its stages: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  cached(runId: string): RunStages | null {
    return this.cache.get(runId) ?? null;
  }

  async move(
    runId: string,
    request: StageMoveRequest,
    actor: StageActor,
    options: { expectedRev?: number } = {},
  ): Promise<StageMoveResult> {
    return this.writes.run(runId, async () => {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      const team = run === null ? null : await this.teamOf(run, em);
      const stages = team === null ? null : walkableStages(team);
      if (run === null || team === null || stages === null) {
        return refuse('NO_STAGES', 'This run has no stages.');
      }
      if (run.archivedAt !== null) {
        return refuse(
          'RUN_ARCHIVED',
          'This run is archived — unarchive it to move its stages.',
        );
      }
      const moves = await this.movesOf(runId, em);
      const before = foldStages(stages, moves);
      const column = readRunStageProgress(run.stageProgress);
      if (column !== null && column.rev !== before.rev) {
        await this.sync(runId, before, em);
      }
      if (
        options.expectedRev !== undefined &&
        options.expectedRev !== before.rev
      ) {
        return refuse(
          'STAGE_PROGRESS_CHANGED',
          'The stages moved since you looked; reload them and try again.',
        );
      }
      const text = request.text.trim();
      const refusal =
        checkText(text, actor) ?? checkMove(stages, before, request);
      if (refusal !== null) {
        return refusal;
      }
      const stage = stages.find((s) => s.id === request.stage)!;
      const forks = stage.next ?? [];
      const payload: StageChangePayload = {
        action: request.action,
        stageId: stage.id,
        stageTitle: stage.title,
        ...(request.action !== 'reopen' && forks.length > 1 && request.next
          ? { next: request.next }
          : {}),
        text,
        rev: before.rev + 1,
        by: actor,
      };
      const resets =
        request.action === 'reopen'
          ? stagesReopenResets(stages, before, stage.id)
          : [];
      // Deleting a run does not go through the queue.
      if ((await this.runDao.getById(runId, this.em.fork())) === null) {
        return refuse('NO_STAGES', 'This run has no stages.');
      }
      const row = await persistItemAndEmit(
        {
          itemDao: this.itemDao,
          bus: this.bus,
          calls: this.calls,
          seqs: this.seqs,
        },
        em,
        {
          runId,
          memberId: null,
          seq: await this.seqs.reserve(runId),
          kind: 'stage_change',
          role: null,
          payload,
        },
      );
      const progress = foldStages(stages, [
        ...moves,
        toMove(payload, row.createdAt),
      ]);
      await this.sync(runId, progress, em);
      this.cache.set(runId, {
        stages,
        progress,
        leadId: triggerMemberId(team),
      });
      return { ok: true, stages, team, progress, resets, payload };
    });
  }

  async note(
    runId: string,
    action: 'nudge' | 'stalled',
    stage: TeamStage,
    rev: number,
    text: string,
  ): Promise<boolean> {
    return this.writes.run(runId, async () => {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (run === null || run.archivedAt !== null) {
        return false;
      }
      await persistItemAndEmit(
        {
          itemDao: this.itemDao,
          bus: this.bus,
          calls: this.calls,
          seqs: this.seqs,
        },
        em,
        {
          runId,
          memberId: null,
          seq: await this.seqs.reserve(runId),
          kind: 'stage_change',
          role: null,
          payload: {
            action,
            stageId: stage.id,
            stageTitle: stage.title,
            text,
            rev,
            by: { kind: 'system' },
          } satisfies StageChangePayload,
        },
      );
      return true;
    });
  }

  async notesOf(
    runId: string,
  ): Promise<{ action: 'nudge' | 'stalled'; stageId: string; rev: number }[]> {
    const rows = await this.itemDao.stageChangeRows(runId, this.em.fork());
    return rows.flatMap((row) => {
      const payload = readPayload(row.payload);
      return payload !== null &&
        (payload.action === 'nudge' || payload.action === 'stalled')
        ? [
            {
              action: payload.action,
              stageId: payload.stageId,
              rev: payload.rev,
            },
          ]
        : [];
    });
  }

  private async teamOf(run: Run, em: EntityManager): Promise<Team | null> {
    if (run.teamId === null) {
      return null;
    }
    try {
      return await this.runTeams.teamOf({ ...run, teamId: run.teamId }, em);
    } catch (error) {
      this.logger.warn(
        `run ${run.id}: its team copy cannot be read, so it has no stages: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async movesOf(
    runId: string,
    em: EntityManager,
  ): Promise<StageMove[]> {
    const rows = await this.itemDao.stageChangeRows(runId, em);
    return rows.flatMap((row) => {
      const payload = readPayload(row.payload);
      if (
        payload === null ||
        payload.action === 'nudge' ||
        payload.action === 'stalled'
      ) {
        return [];
      }
      return [toMove(payload, row.createdAt.toISOString())];
    });
  }

  private async sync(
    runId: string,
    progress: StageProgress,
    em: EntityManager,
  ): Promise<void> {
    const stored = await this.store(runId, progress, em);
    if (this.announcedRevs.get(runId) !== progress.rev) {
      this.announcedRevs.set(runId, progress.rev);
      const announced = readRunStageProgress(writeRunStageProgress(progress));
      if (announced !== null) {
        this.bus.publishRunStatus({ runId, status: null, stages: announced });
      }
    }
    if (stored) {
      this.unsynced.delete(runId);
      clearTimeout(this.retries.get(runId));
      this.retries.delete(runId);
      return;
    }
    this.unsynced.add(runId);
    if (!this.retries.has(runId)) {
      const timer = setTimeout(() => {
        this.retries.delete(runId);
        void this.writes.run(runId, async () => {
          const cached = this.cache.get(runId);
          if (cached !== undefined && this.unsynced.has(runId)) {
            await this.sync(runId, cached.progress, this.em.fork());
          }
        });
      }, STAGE_COLUMN_RETRY_MS);
      timer.unref();
      this.retries.set(runId, timer);
    }
  }

  private async store(
    runId: string,
    progress: StageProgress,
    em: EntityManager,
  ): Promise<boolean> {
    const stageProgress = writeRunStageProgress(progress);
    let stored = true;
    try {
      await this.runDao.updateWithoutActivity(runId, { stageProgress }, em);
    } catch (error) {
      stored = false;
      this.logger.error(
        `run ${runId}: stage progress rev ${progress.rev} is not in its column, so the next read refolds it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return stored;
  }
}

function readPayload(raw: string): StageChangePayload | null {
  const parsed = StageChangePayloadSchema.safeParse(parseJsonColumn(raw));
  return parsed.success ? parsed.data : null;
}

function toMove(payload: StageChangePayload, at: string): StageMove {
  return {
    action: payload.action as StageMoveAction,
    stageId: payload.stageId,
    ...(payload.next !== undefined ? { next: payload.next } : {}),
    text: payload.text,
    by: payload.by,
    at,
  };
}

function refuse(
  code: StageRefusalCode,
  message: string,
): Extract<StageMoveResult, { ok: false }> {
  return { ok: false, code, message };
}

function checkText(
  text: string,
  actor: StageActor,
): Extract<StageMoveResult, { ok: false }> | null {
  if (text.length === 0) {
    return refuse(
      'TEXT_REQUIRED',
      'Say in one line what was done, or why — "text" is required.',
    );
  }
  if (text.length > MAX_STAGE_TEXT_LENGTH) {
    return refuse(
      'TEXT_TOO_LONG',
      `Keep "text" to ${MAX_STAGE_TEXT_LENGTH} characters; it is a summary, not the work.`,
    );
  }
  if (
    actor.kind === 'agent' &&
    text.split('\n').length > MAX_AGENT_STAGE_TEXT_LINES
  ) {
    return refuse(
      'TEXT_TOO_LONG',
      `Keep "text" to ${MAX_AGENT_STAGE_TEXT_LINES} lines; it is a summary, not the work.`,
    );
  }
  return null;
}

function checkMove(
  stages: readonly TeamStage[],
  progress: StageProgress,
  request: StageMoveRequest,
): Extract<StageMoveResult, { ok: false }> | null {
  const stage = stages.find((s) => s.id === request.stage);
  if (stage === undefined) {
    return refuse(
      'STAGE_UNKNOWN',
      `There is no stage '${request.stage}'. Stages: ${stages.map((s) => s.id).join(', ')}.`,
    );
  }
  if (request.action === 'reopen') {
    const reopenable = progress.stages
      .filter((s) => s.status === 'done' || s.status === 'skipped')
      .map((s) => s.id);
    if (!reopenable.includes(stage.id)) {
      return refuse(
        'NOT_REOPENABLE',
        reopenable.length === 0
          ? `Only a finished or skipped stage can be reopened, and none is yet.`
          : `Only a finished or skipped stage can be reopened: ${reopenable.join(', ')}.`,
      );
    }
    return null;
  }
  if (progress.current === null) {
    return refuse(
      'STAGES_FINISHED',
      'Every stage is already done; reopen one to change it.',
    );
  }
  if (progress.current !== stage.id) {
    const current = stages.find((s) => s.id === progress.current);
    return refuse(
      'STAGE_NOT_CURRENT',
      `'${stage.id}' is not the current stage — the current stage is ${current?.title ?? progress.current} (${progress.current}).`,
    );
  }
  const forks = stage.next ?? [];
  if (forks.length > 1) {
    if (request.next === undefined) {
      return refuse(
        'NEXT_REQUIRED',
        `${stage.title} is followed by ONE of: ${forks.join(', ')} — name the one the run takes as "next".`,
      );
    }
    if (!forks.includes(request.next)) {
      return refuse(
        'NEXT_INVALID',
        `'${request.next}' does not follow ${stage.title}; it is followed by ONE of: ${forks.join(', ')}.`,
      );
    }
    return null;
  }
  if (request.next !== undefined && request.next !== forks[0]) {
    return refuse(
      'NEXT_INVALID',
      forks.length === 0
        ? `${stage.title} is the final stage; leave "next" out.`
        : `${stage.title} is always followed by ${forks[0]}; leave "next" out.`,
    );
  }
  return null;
}
