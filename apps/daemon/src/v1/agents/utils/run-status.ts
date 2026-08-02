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
): Promise<void> {
  await deps.runDao.updateById(runId, { status }, em);
  deps.bus.publishRunStatus({ runId, status, activity });
}
