import { z } from 'zod';

import type { MonitorStopOutcome } from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import {
  applyArgSynonyms,
  type ArgSynonyms,
  leadWithCall,
} from '../../../../utils/tool-arg-synonyms';
import { readToolArgs } from '../tool-args';

export const STOP_MONITOR_SYNONYMS: ArgSynonyms = {
  monitor_id: 'id',
  monitor: 'id',
};

const STOP_MONITOR_CALL = 'call stop_monitor({id: "m1"}).';

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
  const renamed = applyArgSynonyms(args, STOP_MONITOR_SYNONYMS);
  const read = renamed.ok
    ? readToolArgs(StopMonitorArgsSchema, renamed.args)
    : renamed;
  return read.ok
    ? { id: read.query.id }
    : { error: leadWithCall(STOP_MONITOR_CALL, read.error) };
}

/** The receipt for a stop that was not refused. */
export function stopMonitorResultText(
  outcome:
    Exclude<MonitorStopOutcome, { status: 'refused' }> | HostSinkUnavailable,
  id: string,
): string {
  if (outcome.status === 'unavailable') {
    return `Not stopped: ${outcome.reason}.`;
  }
  if (outcome.status === 'ended') {
    return `Monitor ${id} already ended: ${outcome.end}. Nothing more is sent from it.`;
  }
  return `Stopped monitor ${id}. Nothing more is sent from it.`;
}
