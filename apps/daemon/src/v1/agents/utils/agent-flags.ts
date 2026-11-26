import { randomBytes } from 'node:crypto';

import type { InterruptCause } from '../../../utils/stop-cause';
import type { AgentFlag } from '../../runs/entity/agent-flag.entity';
import type { Run } from '../../runs/entity/run.entity';
import {
  AGENT_FLAG_MINUTES_MAX,
  type AgentFlagRunKind,
  type AgentFlagWire,
} from '../chat.types';

export function newAgentFlagHandle(): string {
  return `F-${randomBytes(3).toString('hex')}`;
}

/** The kind of thread a run is, as a flag raised in it records it. */
export function agentFlagRunKindOf(
  run: Pick<
    Run,
    | 'teamId'
    | 'analysisPurpose'
    | 'analysisSourceRunId'
    | 'analysisTeamSlug'
    | 'editsTeamSlug'
    | 'editsProjectId'
    | 'commandCenter'
  >,
): AgentFlagRunKind {
  switch (run.analysisPurpose) {
    case 'lessons':
      return 'lessons';
    case 'lessons_check':
      return 'lessons_check';
    case 'system':
      return 'system_analysis';
    default:
      break;
  }
  if (run.analysisTeamSlug !== null) {
    return 'team_analysis';
  }
  if (run.analysisSourceRunId !== null) {
    return 'thread_analysis';
  }
  if (run.commandCenter === true) {
    return 'command_center';
  }
  if (run.editsTeamSlug !== null) {
    return 'builder';
  }
  if (run.editsProjectId !== null) {
    return 'project';
  }
  return run.teamId !== null ? 'team' : 'chat';
}

export function agentFlagWire(flag: AgentFlag): AgentFlagWire {
  return {
    handle: flag.handle,
    runId: flag.runId,
    seq: flag.seq,
    occurredAt: flag.occurredAt.toISOString(),
    memberId: flag.memberId,
    callId: flag.callId,
    agentKind: flag.agentKind,
    model: flag.model,
    teamSlug: flag.teamSlug,
    projectId: flag.projectId,
    runKind: flag.runKind,
    runTitle: flag.runTitle,
    cost: flag.cost,
    category: flag.category,
    minutesLost: flag.minutesLost,
    summary: flag.summary,
    detail: flag.detail,
    automatic: flag.automatic,
  };
}

export const autoFlagCause = {
  interrupted: (cause: InterruptCause): string => `interrupted:${cause}`,
  toolFailure: (tool: string): string => `tool_failure:${tool}`,
  toolRefused: (tool: string): string => `tool_refused:${tool}`,
};

/** Whole minutes from `fromMs` to `toMs`, rounded up, at least one and at most what a flag records. */
export function minutesLostBetween(fromMs: number, toMs: number): number {
  return Math.min(
    AGENT_FLAG_MINUTES_MAX,
    Math.max(1, Math.ceil((toMs - fromMs) / 60_000)),
  );
}

/** A summary's identity for the duplicate check: case and spacing do not make a new flag. */
export function flagSummaryKey(summary: string): string {
  return summary.trim().replace(/\s+/g, ' ').toLowerCase();
}
