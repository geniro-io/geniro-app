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
  if (run.workflowId) {
    throw new BadRequestException(
      'NOT_A_CHAT_RUN',
      'run is not a single-agent chat',
    );
  }
  return run;
}

export function assertWorkflowRun(run: Run | null, runId: string): Run {
  if (!run) {
    throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
  }
  if (!run.workflowId) {
    throw new BadRequestException(
      'NOT_A_WORKFLOW_RUN',
      'run is not a workflow (graph) run',
    );
  }
  return run;
}
