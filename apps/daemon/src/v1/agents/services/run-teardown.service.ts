import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { AgentEventBus } from './agent-events.bus';
import { AttachmentStoreService } from './attachment-store.service';
import { PartialStreamService } from './partial-stream.service';
import { ProcessRegistry } from './process-registry';

/**
 * How long a purge waits for a cancelled turn to finish writing before it
 * destroys the run's rows anyway. Bounded on purpose: a wedged child must not
 * hang a delete the user asked for, and `cancel()` already escalates
 * SIGTERM→SIGKILL well inside this window.
 */
export const DELETE_SETTLE_TIMEOUT_MS = 5_000;

/**
 * The teardown behind EVERY run delete — a single-agent chat
 * (`ChatService.delete`) and a workflow run (`GraphExecutorService.deleteRun`)
 * alike. Extracted rather than mirrored: the two kinds of run own the same
 * stores, so a second copy is how one of them silently keeps leaking a store
 * the other learned to clear.
 *
 * A delete is a ONE-WAY DOOR — there is no trash and none is planned, so
 * nothing here is recoverable.
 *
 * Order matters. The live turn is stopped FIRST: a running turn writes items as
 * it goes, so deleting its rows underneath it would let the turn re-create some
 * of them after the delete "finished".
 *
 * Every store the run touched is then cleared, because none of them cascade:
 * `Item.runId` is a plain string column with no FK, `node_state` is keyed by
 * `(runId, nodeId)`, attachments are files on disk, PTY mirrors are in memory,
 * and call tokens are in a registry. A delete that dropped only the `runs` row
 * would leave every one of those behind, invisible and unreachable.
 *
 * What it deliberately does NOT do is decide WHICH runs may be deleted, or wait
 * for the caller's own notion of "finished": the run-kind guard and the settle
 * promise both come from the caller, because a chat waits on its turn finalizer
 * while a workflow waits on its aggregate DAG handle.
 */
@Injectable()
export class RunTeardownService {
  private readonly logger = new Logger(RunTeardownService.name);

  constructor(
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly runDao: RunDao,
    private readonly bus: AgentEventBus,
    private readonly registry: ProcessRegistry,
    private readonly callTokens: CallTokenRegistry,
    private readonly partials: PartialStreamService,
    private readonly attachments: AttachmentStoreService,
  ) {}

  /**
   * Stop the run's live work, then destroy everything it owns.
   *
   * `settled` is the caller's in-flight work, or undefined when nothing is in
   * flight. It must resolve only after that work's LAST write — awaiting a
   * turn's child-exit is not enough, since the finalizer that drains the
   * persist queue runs afterwards.
   */
  async purge(
    em: EntityManager,
    runId: string,
    settled: Promise<void> | undefined,
  ): Promise<{ deleted: boolean }> {
    this.registry.cancel(runId);
    // Cancel only SIGNALS; the caller's work keeps writing until it settles.
    // Wait for it before destroying anything, or it persists a terminal item
    // (and swept-approval rows) for a run whose `runs` row is already gone —
    // `Item.runId` has no FK, so those inserts SUCCEED, and the result is
    // transcript text that no route can ever reach or delete again. That is the
    // opposite of what this method promises.
    await this.awaitSettled(runId, settled);

    // The in-memory planes. Cleared first — pure bookkeeping, and a failure
    // here must not leave the durable rows half-deleted.
    this.callTokens.revokeRun(runId);
    this.partials.forgetRun(runId);

    const items = await this.itemDao.hardDeleteIncludingSoftDeleted(
      { runId },
      em,
    );
    const nodeStates = await this.nodeStateDao.hardDeleteIncludingSoftDeleted(
      { runId },
      em,
    );
    await this.runDao.hardDeleteIncludingSoftDeleted({ id: runId }, em);
    this.attachments.removeRun(runId);

    // Announced last, once the run genuinely no longer exists: modules above
    // this one (the PTY mirror) hold per-run state and drop it on this signal.
    this.bus.publishRunDeleted(runId);

    this.logger.log(
      `deleted run ${runId}: ${items} item(s), ${nodeStates} node state(s), attachments and live mirrors dropped`,
    );
    return { deleted: true };
  }

  /**
   * Wait for the run's in-flight work to finish, bounded by
   * {@link DELETE_SETTLE_TIMEOUT_MS}. Resolves immediately when nothing is in
   * flight. A timeout is REPORTED rather than silently accepted: past it the
   * purge destroys the rows anyway, so a straggling writer can still orphan a
   * row, and the log line is the only trace of why.
   */
  private async awaitSettled(
    runId: string,
    settled: Promise<void> | undefined,
  ): Promise<void> {
    if (!settled) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      // Rejection is treated as settled: a failed finalizer has stopped
      // writing, which is all this wait is about.
      settled.then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), DELETE_SETTLE_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
    if (timedOut) {
      this.logger.warn(
        `run ${runId} did not settle within ${DELETE_SETTLE_TIMEOUT_MS}ms — deleting anyway; a late write may orphan a row`,
      );
    }
  }
}
