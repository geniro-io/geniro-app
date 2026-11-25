import { BadRequestException, NotFoundException } from '@packages/common';

import type { Run } from '../../runs/entity/run.entity';

/**
 * Run-kind guards shared by the chat and team endpoints (extracted, never
 * mirrored). Both cancel paths converge on the same registry key, so a
 * wrong-endpoint call must fail loudly instead of silently cancelling the
 * other kind's run.
 */
export function assertChatRun(run: Run | null, runId: string): Run {
  if (!run) {
    throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
  }
  if (run.teamId) {
    throw new BadRequestException(
      'NOT_A_CHAT_RUN',
      'run is not a single-agent chat',
    );
  }
  return run;
}

/** A run {@link assertTeamRun} has vouched for: it names its team. */
export type TeamRun = Run & { teamId: string };

function namesTeam(run: Run): run is TeamRun {
  return Boolean(run.teamId);
}

export function assertTeamRun(run: Run | null, runId: string): TeamRun {
  if (!run) {
    throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
  }
  if (!namesTeam(run)) {
    throw new BadRequestException('NOT_A_TEAM_RUN', 'run is not a team run');
  }
  return run;
}

/** The `teamId` of a chat promoted into a team run: never a library slug, since `SLUG_RE` refuses `:`. */
export function chatTeamIdOf(runId: string): string {
  return `${CHAT_TEAM_ID_PREFIX}${runId}`;
}

/** Whether a run is a chat promoted in place into a team run (a chat team). */
export function isChatTeamRun(run: Pick<Run, 'teamOrigin'>): boolean {
  return run.teamOrigin === CHAT_TEAM_ORIGIN;
}

export const CHAT_TEAM_ORIGIN = 'chat';

const CHAT_TEAM_ID_PREFIX = 'chat:';

/**
 * Whether a run's `teamId` names a chat team rather than a library slug —
 * for readers that hold the id but not the run's `teamOrigin`.
 */
export function isChatTeamId(teamId: string | null): boolean {
  return teamId !== null && teamId.startsWith(CHAT_TEAM_ID_PREFIX);
}
