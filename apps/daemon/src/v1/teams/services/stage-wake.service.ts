import {
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { BadRequestException, ConflictException } from '@packages/common';

import type { HostRowWire, StageProgress } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { HostWakeBus } from '../../agents/services/host-wake.bus';
import { TeamNoteBroker } from '../../agents/services/team-note.broker';
import type { StageMoved, StageMoveRequest } from '../teams.types';
import { callerKey } from '../utils/caller-key';
import {
  handOffBrief,
  handOffLine,
  memberName,
  userMoveWake,
} from '../utils/stage-text';
import { StageService } from './stage.service';
import { TeamExecutorService } from './team-executor.service';

export interface UserStageMove {
  progress: StageProgress;
  woke: boolean;
  hasLead: boolean;
}

@Injectable()
export class StageWakeService implements OnModuleInit {
  private readonly logger = new Logger(StageWakeService.name);

  constructor(
    private readonly stages: StageService,
    private readonly executor: TeamExecutorService,
    private readonly wakes: HostWakeBus,
    private readonly bus: AgentEventBus,
    @Optional() private readonly teamNotes?: TeamNoteBroker,
  ) {}

  onModuleInit(): void {
    this.stages.onMoved((runId, moved) => {
      if (moved.actor.kind !== 'agent') {
        return;
      }
      void this.handOff(runId, moved).catch((err: unknown) => {
        this.logger.warn(
          `run ${runId}: could not hand the run to the next lead: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    this.executor.onRunSettledCompleted((runId) => {
      void this.nudgeIfStalled(runId).catch((err: unknown) => {
        this.logger.warn(
          `run ${runId}: could not check its stages: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  async nudgeIfStalled(runId: string): Promise<void> {
    const loaded = await this.stages.current(runId);
    if (loaded === null || loaded.progress.current === null) {
      return;
    }
    if (await this.stages.isWaiting(runId)) {
      return;
    }
    const { progress, stages, leadId } = loaded;
    const stage = stages.find((s) => s.id === progress.current);
    if (stage === undefined) {
      return;
    }
    const here = (await this.stages.notesOf(runId)).filter(
      (note) => note.stageId === stage.id && note.rev === progress.rev,
    );
    if (here.some((note) => note.action === 'stalled')) {
      return;
    }
    const nudged = here.some((note) => note.action === 'nudge');
    if (leadId !== null && !nudged) {
      const text = `Stage ${stage.title} is still open: finish it with move_stage, skip it with a reason, or say what blocks it.`;
      if (
        !(await this.stages.note(runId, 'nudge', stage, progress.rev, text))
      ) {
        return;
      }
      const generation = this.stages.generation(runId);
      await this.wakeLead(
        runId,
        leadId,
        `stage:${runId}:nudge:${progress.rev}`,
        `[geniro] ${text}\n${stageBriefLine(stage)}`,
        'Woke the lead to finish the open stage',
        () =>
          this.stages.generation(runId) !== generation ||
          this.stages.cached(runId)?.progress.rev !== progress.rev,
      );
      return;
    }
    const text = nudged
      ? `Stage ${stage.title} is still open after a nudge, and the agents have stopped.`
      : `Stage ${stage.title} is still open, and the agents have stopped.`;
    if (
      !(await this.stages.note(runId, 'stalled', stage, progress.rev, text))
    ) {
      return;
    }
    this.bus.publishRunStatus({ runId, status: null, notify: text });
  }

  async userMove(
    runId: string,
    request: StageMoveRequest,
    via: 'desktop' | 'remote',
    expectedRev: number,
  ): Promise<UserStageMove> {
    const result = await this.stages.move(
      runId,
      request,
      { kind: 'user', via },
      { expectedRev },
    );
    if (!result.ok) {
      if (
        result.code === 'STAGE_PROGRESS_CHANGED' ||
        result.code === 'RUN_ARCHIVED'
      ) {
        throw new ConflictException(result.code, result.message);
      }
      throw new BadRequestException(result.code, result.message);
    }
    const lead = result.lead;
    const moved: StageMoved = { ...result, actor: { kind: 'user', via } };
    const handedOff = await this.notedHandOff(runId, moved);
    const text = handedOff
      ? await this.briefFor(runId, moved, {
          action: request.action,
          stageId: result.payload.stageId,
          text: result.payload.text,
        })
      : userMoveWake(
          result.stages,
          result.team.members,
          {
            action: request.action,
            stageId: result.payload.stageId,
            ...(result.payload.next !== undefined
              ? { next: result.payload.next }
              : {}),
            text: result.payload.text,
          },
          result.progress,
          result.resets,
          result.team.mode,
        );
    const woke = await this.wakeLead(
      runId,
      lead,
      `stage:${runId}:${result.payload.rev}`,
      text,
      handedOff
        ? `Handed the run to ${memberName(result.team.members, lead!)} with your reason`
        : 'Woke the lead with your reason',
      handedOff ? this.handOffWithdrawn(runId, moved) : undefined,
    );
    return {
      progress: result.progress,
      woke,
      hasLead: lead !== null,
    };
  }

  /**
   * A relay run whose lead changed with an agent's move: the next stage's
   * lead is woken in its own conversation with a hand-off brief, under a
   * hand-off row. The previous lead's conversation is left as it is.
   */
  async handOff(runId: string, moved: StageMoved): Promise<boolean> {
    if (!(await this.notedHandOff(runId, moved))) {
      return false;
    }
    return this.wakeLead(
      runId,
      moved.lead,
      `stage:${runId}:${moved.payload.rev}`,
      await this.briefFor(runId, moved),
      `Handed the run to ${memberName(moved.team.members, moved.lead!)}`,
      this.handOffWithdrawn(runId, moved),
    );
  }

  /** A held hand-off is stale once the run has moved on or is led by someone else. */
  private handOffWithdrawn(runId: string, moved: StageMoved): () => boolean {
    const generation = this.stages.generation(runId);
    return () => {
      const now = this.stages.cached(runId);
      return (
        this.stages.generation(runId) !== generation ||
        now?.progress.rev !== moved.progress.rev ||
        now.leadId !== moved.lead
      );
    };
  }

  /** Whether the move hands the run on, its hand-off row written when it does. */
  private async notedHandOff(
    runId: string,
    moved: StageMoved,
  ): Promise<boolean> {
    const { team, stages, progress, lead, previousLead, payload } = moved;
    if (team.mode !== 'relay' || lead === null || lead === previousLead) {
      return false;
    }
    const stage =
      stages.find((s) => s.id === progress.current) ??
      stages.find((s) => s.id === payload.stageId);
    if (stage === undefined) {
      return false;
    }
    await this.stages.note(
      runId,
      'handoff',
      stage,
      payload.rev,
      handOffLine(stages, team.members, progress, lead),
      lead,
    );
    return true;
  }

  private async briefFor(
    runId: string,
    moved: StageMoved,
    userReason?: {
      action: StageMoveRequest['action'];
      stageId: string;
      text: string;
    },
  ): Promise<string> {
    const lead = moved.lead!;
    return handOffBrief({
      stages: moved.stages,
      members: moved.team.members,
      progress: moved.progress,
      lead,
      previousLead: moved.previousLead,
      request: await this.stages.requestOf(runId),
      unreadTeamNotes:
        this.teamNotes?.unreadCount(runId, {
          memberId: lead,
          conversationId: null,
        }) ?? 0,
      ...(userReason === undefined ? {} : { userReason }),
    });
  }

  async wakeLead(
    runId: string,
    lead: string | null,
    key: string,
    prompt: string,
    rowMessage: string,
    withdrawn?: () => boolean,
  ): Promise<boolean> {
    if (lead === null) {
      return false;
    }
    const reachable = this.executor.canWake(runId);
    if (
      !reachable &&
      (await this.executor.continueAsHost(runId, lead, prompt, {
        severity: 'info',
        message: rowMessage,
      }))
    ) {
      return true;
    }
    const row: HostRowWire = {
      severity: 'info',
      message: rowMessage,
      woke: true,
    };
    this.wakes.publish({
      key,
      owner: {
        runId,
        memberId: lead,
        conversationId: null,
        caller: callerKey(lead, null),
        target: 'team',
      },
      prompt,
      row,
      note: prompt,
      onDelivered: () => undefined,
      ...(withdrawn !== undefined ? { withdrawn } : {}),
    });
    return reachable;
  }
}

function stageBriefLine(stage: { goal: string }): string {
  return `Goal: ${stage.goal.trim()}`;
}
