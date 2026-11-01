import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { BadRequestException, ConflictException } from '@packages/common';

import type { HostRowWire, StageProgress } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { HostWakeBus } from '../../agents/services/host-wake.bus';
import type { StageMoveRequest } from '../teams.types';
import { callerKey } from '../utils/caller-key';
import { leadAgentId } from '../utils/graph-order';
import { userMoveWake } from '../utils/stage-text';
import { GraphExecutorService } from './graph-executor.service';
import { StageService } from './stage.service';

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
    private readonly executor: GraphExecutorService,
    private readonly wakes: HostWakeBus,
    private readonly bus: AgentEventBus,
  ) {}

  onModuleInit(): void {
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
    const lead = leadAgentId(result.team.nodes, result.team.edges);
    const text = userMoveWake(
      result.stages,
      result.team.nodes,
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
    );
    const woke = await this.wakeLead(
      runId,
      lead,
      `stage:${runId}:${result.payload.rev}`,
      text,
      'Woke the lead with your reason',
    );
    return {
      progress: result.progress,
      woke,
      hasLead: lead !== null,
    };
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
        nodeId: lead,
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

function stageBriefLine(stage: { doneWhen: string }): string {
  return `Done when: ${stage.doneWhen.trim()}`;
}
