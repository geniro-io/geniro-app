import { BadRequestException, NotFoundException } from '@packages/common';

import type { Run } from '../../runs/entity/run.entity';

/**
 * Run-kind guards shared by the chat and graph endpoints (extracted, never
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
    throw new BadRequestException(
      'NOT_A_TEAM_RUN',
      'run is not a team (graph) run',
    );
  }
  return run;
}
