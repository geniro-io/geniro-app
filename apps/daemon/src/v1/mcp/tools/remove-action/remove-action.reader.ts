import { z } from 'zod';

import type { ActionToolOutcome } from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { readToolArgs } from '../tool-args';

const RemoveActionArgsSchema = z
  .object({ action_id: z.string().trim().min(1) })
  .strict();

/** The id to remove, or what is wrong with the call. Never throws. */
export function readRemoveAction(
  args: Record<string, unknown>,
): string | { error: string } {
  const read = readToolArgs(RemoveActionArgsSchema, args);
  return read.ok ? read.query.action_id : { error: read.error };
}

/** The receipt for a removal that was not refused. */
export function removeActionResultText(
  outcome:
    Exclude<ActionToolOutcome, { status: 'refused' }> | HostSinkUnavailable,
): string {
  return outcome.status === 'unavailable'
    ? `Not removed: ${outcome.reason}.`
    : outcome.text;
}
