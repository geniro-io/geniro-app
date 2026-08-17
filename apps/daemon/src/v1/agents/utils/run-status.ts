import type { EntityManager } from '@mikro-orm/sqlite';

import type { RunStatus } from '../../runs/runs.types';
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
export async function writeRunStatus(
  deps: { runDao: RunDao; bus: AgentEventBus },
  em: EntityManager,
  runId: string,
  status: RunStatus,
  /** What the run is doing right now, for a badge nobody is looking at. */
  activity: string | null = null,
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
   * Null on every non-terminal write, where there is nothing to summarise.
   */
  summary: string | null = null,
): Promise<void> {
  await deps.runDao.updateById(runId, { status }, em);
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
  deps.bus.publishRunStatus({
    runId,
    status,
    activity,
    awaiting: null,
    ...(summary === null ? {} : { summary }),
  });
}
