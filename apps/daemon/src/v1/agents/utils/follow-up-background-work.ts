import { ConflictException } from '@packages/common';

/**
 * Answers a Send-now press whose message would cancel running sub-agents.
 * Distinct from `RUN_BUSY`: only a press that said `backgroundWork: 'ask'`
 * meets it, and the press has a question to put to the user rather than a
 * queue to fall back on.
 */
export function subagentsWouldBeCancelled(count: number): ConflictException {
  return new ConflictException(
    'FOLLOW_UP_CANCELS_SUBAGENTS',
    count === 1
      ? 'Sending this now cancels the sub-agent still running, and whatever it has not finished is lost.'
      : `Sending this now cancels the ${count} sub-agents still running, and whatever they have not finished is lost.`,
  );
}
