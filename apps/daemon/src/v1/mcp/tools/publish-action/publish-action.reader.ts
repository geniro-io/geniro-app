import { z } from 'zod';

import type {
  ActionPublishInput,
  ActionToolOutcome,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { readToolArgs } from '../tool-args';

/**
 * Strict on the names (a misspelt `mesage` must not publish a button that
 * sends nothing) and loose on the kinds: `stop` and `command` are read whatever
 * their shape so the service can answer that they are not available yet,
 * rather than the call failing on a schema it was never shown.
 */
const PublishActionArgsSchema = z
  .object({
    label: z.string(),
    description: z.string().optional(),
    action_id: z.string().optional(),
    once: z.boolean().optional(),
    message: z.string().optional(),
    stop: z.unknown().optional(),
    command: z.unknown().optional(),
  })
  .strict();

/** The call's arguments, or what is wrong with them. Never throws. */
export function readPublishAction(
  args: Record<string, unknown>,
): ActionPublishInput | { error: string } {
  const read = readToolArgs(PublishActionArgsSchema, args);
  if (!read.ok) {
    return { error: read.error };
  }
  const { query } = read;
  return {
    label: query.label,
    ...(query.description === undefined
      ? {}
      : { description: query.description }),
    ...(query.action_id === undefined ? {} : { actionId: query.action_id }),
    ...(query.once === undefined ? {} : { once: query.once }),
    ...(query.message === undefined ? {} : { message: query.message }),
    ...(query.stop === undefined ? {} : { stop: query.stop }),
    ...(query.command === undefined ? {} : { command: query.command }),
  };
}

/** The receipt for a publish that was not refused. */
export function publishActionResultText(
  outcome:
    Exclude<ActionToolOutcome, { status: 'refused' }> | HostSinkUnavailable,
): string {
  return outcome.status === 'unavailable'
    ? `Not published: ${outcome.reason}.`
    : outcome.text;
}
