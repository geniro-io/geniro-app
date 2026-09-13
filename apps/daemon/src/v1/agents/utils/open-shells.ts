import type { AgentEvent } from '../adapters/adapter.types';
import { asRecord, asString, parseJsonColumn } from './json-util';

/**
 * The DETACHED commands a run's transcript still declares running, folded from
 * its own `shell_open` / `shell_info` rows in seq order — the twin of
 * `open-delegates.ts` for the other kind of background unit.
 *
 * A shell's end is ordinarily written by `spawn-cli` itself: when the CLI
 * process dies, every command it still had out dies with its group, and the
 * exit announces a close for each. That announcement reaches the transcript
 * only through the owner's between-turn sink, and two owners are not listening
 * when it comes — a workflow run that has FINISHED, whose sink stops at
 * `runFinished` one step before its teardown kills the processes, and a daemon
 * that died before any of it could run. Both leave the command listed as
 * running for the life of the transcript, and the transcript is then the only
 * record of what was still out.
 *
 * A close is matched to its shell the way the renderer matches it
 * (`settleFromShellInfo` in `shell-activity.ts`): by the launching call where
 * the close names one, else by the CLI's own work id.
 */

/** A `shell_open` / `shell_info` row as it is read back to be folded. */
export interface ShellRow {
  kind: string;
  /** The column as stored — JSON text. */
  payload: unknown;
  nodeId: string | null;
}

/**
 * A detached command still declared running, and where its close has to be
 * filed — the same node and call as its open row, for the reason
 * `StrandedDelegate` spells out.
 */
export interface StrandedShell {
  toolCallId: string | null;
  workId: string;
  nodeId: string | null;
  callId: string | null;
}

export function strandedShells(rows: readonly ShellRow[]): StrandedShell[] {
  // Keyed by the work id, which every open carries; the launching call is an
  // alias a close may name instead.
  const open = new Map<string, StrandedShell>();
  const workIdOfCall = new Map<string, string>();
  for (const row of rows) {
    const record = asRecord(parseJsonColumn(row.payload));
    if (record === null) {
      continue;
    }
    const toolCallId = asString(record.id) || null;
    const workId = asString(record.workId) || null;
    if (row.kind === 'shell_open') {
      if (workId === null) {
        continue;
      }
      open.set(workId, {
        toolCallId,
        workId,
        nodeId: row.nodeId,
        callId: asString(record.callId) || null,
      });
      if (toolCallId !== null) {
        workIdOfCall.set(toolCallId, workId);
      }
      continue;
    }
    if (row.kind === 'shell_info') {
      const target =
        (toolCallId === null ? undefined : workIdOfCall.get(toolCallId)) ??
        workId;
      if (target !== null) {
        open.delete(target);
      }
    }
  }
  return [...open.values()];
}

/** The close `spawn-cli` would have written had its process exit been heard. */
export function shellCloseEvent(shell: StrandedShell): AgentEvent {
  return {
    type: 'shell_info',
    toolCallId: shell.toolCallId,
    workId: shell.workId,
  };
}
