import type { EntityManager } from '@mikro-orm/sqlite';

import { isTerminalRunStatus, type RunStatus } from '../../runs/runs.types';
import type { RunDao } from '../dao/run.dao';
import type { AgentEventBus } from '../services/agent-events.bus';

/**
 * The one write-then-announce implementation both execution paths (single-agent
 * chat and the graph executor) share: persist the run's status, THEN publish it
 * so every connected client updates that run's badge — not just whichever run
 * the user happens to have open.
 *
 * Extracted rather than mirrored (`.claude/rules/daemon-module-structure.md`)
 * because the two paths write the same column for the same reason, and a
 * status written WITHOUT the announce goes stale invisibly: the row is correct
 * in SQLite while the sidebar keeps showing the old badge until something else
 * forces a refetch. The chat path fixed that behind a helper; the executor's
 * five writes kept calling `runDao.updateById` directly, so every workflow row
 * in the same sidebar still showed the stale badge. One function is what makes
 * that class of divergence impossible rather than merely unlikely.
 */
/**
 * Everything a status write says BESIDES the status itself.
 *
 * One object rather than four trailing parameters, and specifically because two
 * of them are booleans that sit next to each other: positionally,
 * `(…, null, null, false, true)` type-checks whichever way round the last two
 * go, and swapping them announces a compaction as a restore — suppressing the
 * summary instead of the banner, with nothing to catch it. Named at the call
 * site, that mistake cannot be written.
 */
export interface RunStatusAnnounce {
  /** What the run is doing right now, for a badge nobody is looking at. */
  activity?: string | null;
  /**
   * What the run has to SAY about this status — the agent's closing words, or
   * the failure's own message.
   *
   * It rides the announcement because the client that needs it is the one NOT
   * looking: a system notification about a background thread has to be able to
   * say what happened, and the run row it would otherwise read from is only as
   * fresh as the last list fetch — for a chat nobody has open, that is the
   * user's own message from before the turn started.
   *
   * Null on a settle the agent said nothing on, and on every non-terminal
   * write. Those two are told apart on the WIRE rather than here — see the
   * `isTerminalRunStatus` gate below.
   */
  summary?: string | null;
  /**
   * True when this settle's whole turn was the CLI's own context compaction —
   * see {@link RunStatusEvent.housekeeping}. Never set on a non-terminal write:
   * a compaction that a working turn ran mid-flight is not what this names.
   */
  housekeeping?: boolean;
  /**
   * True when this write hands a status BACK rather than reaching a new one —
   * see {@link RunStatusEvent.restored}. Keeps the announce out of the client's
   * "a turn just ended" reading, and withholds `summary` so the restore does
   * not blank the sentence the real settle gave it.
   */
  restored?: boolean;
}

export async function writeRunStatus(
  deps: { runDao: RunDao; bus: AgentEventBus },
  em: EntityManager,
  runId: string,
  status: RunStatus,
  announce: RunStatusAnnounce = {},
): Promise<void> {
  await deps.runDao.updateById(runId, { status }, em);
  // Read AFTER the write, because that is what it describes: the row's own
  // `updatedAt` moved just now, and this is the only announce that can say so
  // (`RunStatusEvent.at`). Taken from the clock rather than read back off the
  // entity to keep the write one query — the two differ by the flush's own
  // latency, which is a sub-millisecond gap in a list ordered by seconds.
  const at = new Date().toISOString();
  // `awaiting: null` on EVERY status write, which is the one place it can be
  // stated once for both paths' many settle branches.
  //
  // It holds because a status write and an open card are mutually exclusive by
  // construction: every settle path sweeps its node's pending approvals (and
  // records each as `unanswerable`) BEFORE rolling the status up, and the only
  // non-terminal write is the `running` a fresh turn starts with, which no card
  // can predate. So a run whose status just changed is a run parked on nothing,
  // and saying so here is what keeps a `needs-input` badge from outliving the
  // turn it belonged to — the card is gone from the screen, and the badge would
  // have gone on claiming the user was the blocker.
  // A TERMINAL status always carries `summary`, null included; a non-terminal
  // one never does. The two are different statements and the wire has to keep
  // them apart: the client holds the last sentence it was given, so omitting a
  // settle's null left the previous turn's closing words standing and a
  // wordless turn announced them as its own — see `RunStatusEvent.summary`.
  const {
    activity = null,
    summary = null,
    housekeeping = false,
    restored = false,
  } = announce;
  const settled = isTerminalRunStatus(status);
  deps.bus.publishRunStatus({
    runId,
    status,
    activity,
    awaiting: null,
    at,
    ...(settled && !restored ? { summary } : {}),
    // Only ever said out loud, never as a `false` nobody reads.
    ...(settled && housekeeping ? { housekeeping } : {}),
    ...(settled && restored ? { restored } : {}),
  });
}
