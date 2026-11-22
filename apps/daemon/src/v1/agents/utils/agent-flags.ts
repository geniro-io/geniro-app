import { randomBytes } from 'node:crypto';

import type { AgentFlag } from '../../runs/entity/agent-flag.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { AgentFlagRunKind, AgentFlagWire } from '../chat.types';

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
  };
}

/** A summary's identity for the duplicate check: case and spacing do not make a new flag. */
export function flagSummaryKey(summary: string): string {
  return summary.trim().replace(/\s+/g, ' ').toLowerCase();
}
