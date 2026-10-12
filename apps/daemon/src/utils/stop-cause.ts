import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

import { DAEMON_STOP_CAUSE_NAME } from './handshake';

/**
 * Why the UI stopped the previous daemon, as it wrote it down.
 *
 * TWIN PARSER: the UI's `DaemonStopCause` in `apps/ui/src/main/daemon-pidfile.ts`
 * is what `writeStopCause` writes; a word this list does not hold reads as
 * `unknown`.
 */
export const DAEMON_STOP_CAUSES = [
  'quit',
  'self-update',
  'restart',
  'crash',
] as const;
export type DaemonStopCause = (typeof DAEMON_STOP_CAUSES)[number];

/** Why a turn found `running` at boot stopped — `unknown` when nobody said. */
export type InterruptCause = DaemonStopCause | 'unknown';

const INTERRUPT_CAUSES: readonly InterruptCause[] = [
  ...DAEMON_STOP_CAUSES,
  'unknown',
];

/** Each cause as the clause a person reads in the transcript and on the board. */
const INTERRUPT_CAUSE_CLAUSE: Record<InterruptCause, string> = {
  quit: 'the app was quit',
  'self-update': 'the app was updated',
  restart: 'the daemon was restarted',
  crash: 'the daemon crashed',
  unknown: 'the daemon stopped unexpectedly',
};

/**
 * Whether work cut off by this cause may be continued with no one looking.
 *
 * Only a stop the app made on purpose and recorded: after a crash, or a stop
 * nobody announced, the agent may have been halfway through an edit, and
 * re-sending the brief would repeat it.
 */
export function resumesUnattended(cause: InterruptCause): boolean {
  return cause === 'quit' || cause === 'self-update' || cause === 'restart';
}

export function interruptCauseClause(cause: InterruptCause): string {
  return INTERRUPT_CAUSE_CLAUSE[cause];
}

/** Why the armed autopilot leaves a card alone after its run was cut off. */
export function interruptedReason(cause: InterruptCause): string {
  return `${interruptCauseClause(cause)} while its agent was working — check the worktree, then press Run to continue`;
}

/** Read a cause back off a stored row; anything else is `unknown`. */
export function parseInterruptCause(value: unknown): InterruptCause {
  return INTERRUPT_CAUSES.find((cause) => cause === value) ?? 'unknown';
}

/**
 * Read and remove the UI's note of why the previous daemon stopped.
 *
 * Removed whatever it said, so it can describe one stop only. A missing,
 * unreadable or undeletable note is `unknown` — the honest answer for a
 * SIGKILL or a power cut, which leave no note.
 */
export function consumeStopCause(userDataDir: string): InterruptCause {
  const path = join(userDataDir, DAEMON_STOP_CAUSE_NAME);
  let written: string;
  try {
    written = readFileSync(path, 'utf8').trim();
  } catch {
    return 'unknown';
  }
  try {
    rmSync(path, { force: true });
  } catch (err) {
    // A note that stays would label the NEXT unannounced stop with this cause,
    // so none is trusted: `unknown` can only ever hold a card, never resume one.
    new Logger('StopCause').error(
      `could not remove ${path} — treating the previous stop as unknown: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'unknown';
  }
  return parseInterruptCause(written);
}
