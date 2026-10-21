import { z } from 'zod';

import {
  MONITOR_COMMAND_MAX,
  MONITOR_DESCRIPTION_MAX,
  MONITOR_TIMEOUT_DEFAULT_MS,
  MONITOR_TIMEOUT_MAX_MS,
  MONITOR_TIMEOUT_MIN_MS,
  type MonitorStartInput,
  type MonitorStartOutcome,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { readToolArgs } from '../tool-args';

// A C0 control character (NUL included, which makes `spawn` throw) has no place
// in a command line or a label.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** Refused rather than clamped: a cut-down timeout is not the one asked for. */
const MonitorArgsSchema = z
  .object({
    command: z
      .string()
      .trim()
      .min(1, 'command is empty')
      .max(MONITOR_COMMAND_MAX)
      .refine(
        (value) => !CONTROL.test(value),
        'command holds a control character',
      ),
    description: z
      .string()
      .trim()
      .min(1, 'description is empty')
      .max(MONITOR_DESCRIPTION_MAX)
      .refine(
        (value) => !CONTROL.test(value) && !value.includes('\n'),
        'description must be one line without control characters',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(MONITOR_TIMEOUT_MIN_MS)
      .max(MONITOR_TIMEOUT_MAX_MS)
      .optional(),
  })
  .strict();

/** The call's arguments, or what is wrong with them. Never throws. */
export function readMonitor(
  args: Record<string, unknown>,
): MonitorStartInput | { error: string } {
  const read = readToolArgs(MonitorArgsSchema, args);
  if (!read.ok) {
    return { error: read.error };
  }
  return {
    command: read.query.command,
    description: read.query.description,
    timeoutMs: read.query.timeout_ms ?? MONITOR_TIMEOUT_DEFAULT_MS,
  };
}

/** The receipt for a start that was not refused. */
export function monitorResultText(
  outcome:
    Exclude<MonitorStartOutcome, { status: 'refused' }> | HostSinkUnavailable,
): string {
  return outcome.status === 'unavailable'
    ? `Not started: ${outcome.reason}.`
    : `Started monitor ${outcome.id}. Its output arrives as your next turns — end this turn rather than wait.`;
}
