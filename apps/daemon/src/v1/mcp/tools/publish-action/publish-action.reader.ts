import { z } from 'zod';

import type {
  ActionPublishInput,
  ActionToolOutcome,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { readToolArgs } from '../tool-args';

/** Strict on the names: a misspelt `mesage` must not publish a button that sends nothing. */
const PublishActionArgsSchema = z
  .object({
    label: z.string(),
    description: z.string().optional(),
    action_id: z.string().optional(),
    once: z.boolean().optional(),
    message: z.string().optional(),
    stop: z
      .object({
        shell: z.string().trim().min(1).optional(),
        pid: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    command: z
      .object({
        argv: z.array(z.string()),
        cwd: z.string().optional(),
        timeout_minutes: z.number().int().optional(),
        notify_agent: z.boolean().optional(),
      })
      .strict()
      .optional(),
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
    ...(query.stop === undefined
      ? {}
      : {
          stop: {
            ...(query.stop.shell === undefined
              ? {}
              : { shell: query.stop.shell }),
            ...(query.stop.pid === undefined ? {} : { pid: query.stop.pid }),
          },
        }),
    ...(query.command === undefined
      ? {}
      : {
          command: {
            argv: query.command.argv,
            ...(query.command.cwd === undefined
              ? {}
              : { cwd: query.command.cwd }),
            ...(query.command.timeout_minutes === undefined
              ? {}
              : { timeoutMinutes: query.command.timeout_minutes }),
            ...(query.command.notify_agent === undefined
              ? {}
              : { notifyAgent: query.command.notify_agent }),
          },
        }),
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
