import { z } from 'zod';

import type { MonitorListing } from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { readToolArgs } from '../tool-args';

const ListMonitorsArgsSchema = z.object({}).strict();

/** Nothing to read, but an argument it does not take is refused, not ignored. */
export function readListMonitors(
  args: Record<string, unknown>,
): Record<string, never> | { error: string } {
  const read = readToolArgs(ListMonitorsArgsSchema, args);
  return read.ok ? {} : { error: read.error };
}

/** The running monitors, as JSON. */
export function listMonitorsResultText(
  outcome: MonitorListing[] | HostSinkUnavailable,
): string {
  if (!Array.isArray(outcome)) {
    return `Not listed: ${outcome.reason}.`;
  }
  if (outcome.length === 0) {
    return 'No monitor of yours is running.';
  }
  return JSON.stringify(
    outcome.map((monitor) => ({
      id: monitor.id,
      description: monitor.description,
      command: monitor.command,
      started_at: monitor.startedAt,
      events: monitor.events,
      timeout_ms: monitor.timeoutMs,
    })),
  );
}
