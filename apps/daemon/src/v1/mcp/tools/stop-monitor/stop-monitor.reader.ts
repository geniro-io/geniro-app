import { z } from 'zod';

import type { MonitorStopOutcome } from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { readToolArgs } from '../tool-args';

const StopMonitorArgsSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^m\d+$/, 'id must look like "m1"'),
  })
  .strict();

/** The call's arguments, or what is wrong with them. Never throws. */
export function readStopMonitor(
  args: Record<string, unknown>,
): { id: string } | { error: string } {
  const read = readToolArgs(StopMonitorArgsSchema, args);
  return read.ok ? { id: read.query.id } : { error: read.error };
}

/** The receipt for a stop that was not refused. */
export function stopMonitorResultText(
  outcome:
    Exclude<MonitorStopOutcome, { status: 'refused' }> | HostSinkUnavailable,
  id: string,
): string {
  return outcome.status === 'unavailable'
    ? `Not stopped: ${outcome.reason}.`
    : `Stopped monitor ${id}. Nothing more is sent from it.`;
}
