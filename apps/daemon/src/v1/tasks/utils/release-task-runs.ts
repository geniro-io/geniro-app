import type { EntityManager, FilterQuery } from '@mikro-orm/sqlite';

import type { RunDao } from '../../agents/dao/run.dao';
import type { Run } from '../../runs/entity/run.entity';

/**
 * Let go of every chat that was working one of these cards, as the cards are
 * deleted — so each becomes an ordinary chat instead of one naming a card that
 * no longer exists.
 *
 * The mirror of `TaskSettleService.releaseDeletedRun`, which clears the CARD's
 * end when its run is deleted; this clears the RUN's end when its card is.
 * Left pointing at a deleted card, a chat went on presenting itself as the
 * card's (the sidebar's `GEN-12` label, "Working the board card …"), and its
 * next message took the task-worktree recovery, which asked the daemon for a
 * card that 404s. The identifier is cleared with the id because the two are
 * written together, and a label for a card that is gone describes nothing.
 *
 * The conversation itself is kept whole — a card's deletion is not a reason to
 * destroy the thread that worked it. Its cwd is the card's worktree, which is
 * collected once the card is gone (a clean one at the delete, a dirty one by
 * the next launch's reap, which counts a missing card as finished and commits
 * the work onto the task's branch first), so the chat can be read and carried
 * on only while that directory stands; after that its next message is refused
 * as any chat's is whose folder was removed.
 *
 * Every run naming a card, not only the one the card names: a card re-pointed
 * at another agent or a workflow opens a new thread, and the earlier ones keep
 * `taskId`. A pure helper rather than a method, because a card delete and a
 * board delete both need it and `ProjectsModule` may not import the tasks
 * module — the reason `removeTaskAttachments` lives beside it.
 */
export async function releaseTaskRuns(
  runDao: RunDao,
  taskIds: readonly string[],
  em: EntityManager,
): Promise<void> {
  if (taskIds.length === 0) {
    return;
  }
  const runs = await runDao.getAll(
    { taskId: { $in: [...taskIds] } } as FilterQuery<Run>,
    {},
    em,
  );
  if (runs.length === 0) {
    return;
  }
  for (const run of runs) {
    run.taskId = null;
    run.taskIdentifier = null;
  }
  await em.flush();
}
