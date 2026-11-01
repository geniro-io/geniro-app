import type { AgentEvent } from '../adapters/adapter.types';
import { asRecord, asString, parseJsonColumn } from './json-util';

/**
 * The DETACHED commands a run's transcript still declares running, folded from
 * its own `shell_open` / `shell_info` rows in seq order — the twin of
 * `open-delegates.ts` for the other kind of background unit.
 *
 * A shell's end is ordinarily written by `spawn-cli` itself: when the CLI
 * process ends, every command it still had out ends with it — its own
 * shutdown stops them, and what a CLI that died without one left is stopped
 * from the groups its session recorded — and the exit announces a close for
 * each. That announcement reaches the transcript
 * only through the owner's between-turn sink, and two owners are not listening
 * when it comes — a team run that has FINISHED, whose sink stops at
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
  memberId: string | null;
}

/**
 * A detached command still declared running, and where its close has to be
 * filed — the same member and call as its open row, for the reason
 * `StrandedDelegate` spells out.
 */
export interface StrandedShell {
  toolCallId: string | null;
  workId: string;
  memberId: string | null;
  callId: string | null;
}

export function strandedShells(rows: readonly ShellRow[]): StrandedShell[] {
  // Keyed by member and work id, which every open carries — a work id is the
  // CLI's per-process counter, as `BackgroundWorkCounts` keys it too. The
  // launching call is an alias a close may name instead.
  const open = new Map<string, StrandedShell>();
  const workIdOfCall = new Map<string, string>();
  for (const row of rows) {
    const record = asRecord(parseJsonColumn(row.payload));
    if (record === null) {
      continue;
    }
    const toolCallId = asString(record.id) || null;
    const workId = asString(record.workId) || null;
    const key = (id: string): string => `${row.memberId ?? ''}\u0000${id}`;
    if (row.kind === 'shell_open') {
      if (workId === null) {
        continue;
      }
      open.set(key(workId), {
        toolCallId,
        workId,
        memberId: row.memberId,
        callId: asString(record.callId) || null,
      });
      if (toolCallId !== null) {
        workIdOfCall.set(key(toolCallId), key(workId));
      }
      continue;
    }
    if (row.kind === 'shell_info') {
      const target =
        (toolCallId === null ? undefined : workIdOfCall.get(key(toolCallId))) ??
        (workId === null ? null : key(workId));
      if (target !== null) {
        open.delete(target);
      }
    }
  }
  return [...open.values()];
}

/**
 * The words a detached command runs, read from the tool call that launched it
 * — its `input.command`, else the tool's own name. Null when the call carries
 * neither. Every reader that names a shell goes through here, so the Terminals
 * list and a caller's call result can never name one command two ways.
 */
export function shellCommandOf(toolCallPayload: unknown): string | null {
  const record = asRecord(parseJsonColumn(toolCallPayload));
  const command =
    asString(asRecord(record?.input)?.command) ?? asString(record?.name);
  return command === null || command === '' ? null : command;
}

/**
 * The tool call that launched a shell, from the run's calls oldest first: the
 * newest with the shell's call id under the same member and team call. An
 * ACP CLI numbers its calls from one in every session, so another
 * conversation can reuse the id; a delegate's call is taken only when no call
 * of the agent's own matches. Every reader that pairs a shell with its call
 * goes through here.
 */
export function launchingCallOf<
  T extends { payload: unknown; memberId: string | null },
>(
  shell: {
    toolCallId: string | null;
    memberId: string | null;
    callId: string | null;
  },
  calls: readonly T[],
): T | undefined {
  if (shell.toolCallId === null) {
    return undefined;
  }
  const matching = calls.filter((row) => {
    const payload = asRecord(parseJsonColumn(row.payload));
    return (
      row.memberId === shell.memberId &&
      asString(payload?.id) === shell.toolCallId &&
      (asString(payload?.callId) || null) === shell.callId
    );
  });
  return (
    matching.filter((row) => !isDelegateCall(row)).at(-1) ?? matching.at(-1)
  );
}

/** Whether a tool call row is a delegate's rather than the agent's own. */
export function isDelegateCall(row: { payload: unknown }): boolean {
  return Boolean(
    asString(asRecord(parseJsonColumn(row.payload))?.parentToolUseId),
  );
}

/** The close `spawn-cli` would have written had its process exit been heard. */
export function shellCloseEvent(shell: StrandedShell): AgentEvent {
  return {
    type: 'shell_info',
    toolCallId: shell.toolCallId,
    workId: shell.workId,
  };
}
