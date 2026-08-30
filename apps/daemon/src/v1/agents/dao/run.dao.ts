import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Run } from '../../runs/entity/run.entity';

@Injectable()
export class RunDao extends BaseDao<Run> {
  constructor(em: EntityManager) {
    super(em, Run);
  }

  /**
   * Single-agent chat runs (no workflow), newest first — one side of the
   * archive or the other, never both.
   */
  async listChats(archived: boolean, txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { workflowId: null, archivedAt: archived ? { $ne: null } : null },
      // Read-only list paths: skip identity-map tracking so a long run history
      // doesn't accumulate managed entities in the forked EM (see item.dao).
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /**
   * Forget the snapshotted custom instructions on every run still holding any,
   * and report how many were cleared.
   *
   * EVERY run, not only the unsettled ones. A settled chat is a chat whose last
   * turn ended, not one that is closed — the user can send it another message
   * at any time, and that turn would re-send the text they retracted. Limiting
   * this to in-flight runs would leave the retention it exists to end.
   *
   * The cost is deliberate and is the whole reason this is a BUTTON rather
   * than something clearing the settings box does on its own: it discards the
   * per-run snapshot, so an old chat continued afterwards runs without the
   * instructions it started under.
   */
  async forgetCustomInstructions(txEm?: EntityManager): Promise<number> {
    return this.getRepo(txEm).nativeUpdate(
      { customInstructions: { $ne: null } },
      { customInstructions: null },
    );
  }

  /**
   * Retitle a run only while its title is still `expected`, and report whether
   * that held.
   *
   * The predicate is the whole point, and it is why auto-naming cannot go
   * through `updateById`: that reads the row, assigns, and flushes, so the write
   * is decided by a snapshot taken before the title was resolved — and resolving
   * one is slow (a `node_state` read, a session-store read, a transcript read).
   * A `PATCH /v1/chats/:runId` rename landing inside that window would be
   * overwritten by a name the user never chose, invisibly: nothing announces the
   * loss, and the screen keeps showing their title until the next listing.
   *
   * `expected: null` claims an unnamed run; a string replaces one auto-name with
   * a better one and refuses if the user has since renamed it. Answering `false`
   * is a real outcome rather than a failure — the run has a name, just not the
   * one this call assumed — and the caller uses it to withhold the announce, so
   * a title that lost the race is never broadcast either.
   */
  async retitle(
    runId: string,
    title: string,
    expected: string | null,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const written = await this.getRepo(txEm).nativeUpdate(
      { id: runId, title: expected },
      { title },
    );
    return written > 0;
  }

  /**
   * File how full this run's context window is, as the CLI just reported it.
   *
   * A bare `nativeUpdate` rather than `updateById`, and for the ordinary reason
   * rather than `retitle`'s: this fires once per main-thread model response, so
   * it must not read the row, hydrate an entity and flush it — nothing here
   * needs the row's other columns, and loading them would put a whole run entity
   * through the identity map several times a minute.
   *
   * Each half is written only when the reading HAS it, and neither is ever
   * cleared. A reading that carries no window has said nothing about the
   * model's, and overwriting a real denominator with silence leaves the ring a
   * numerator it cannot divide; the mirror image holds for the count. That is
   * also why both are optional rather than one call per pair — claude reports
   * the count on every assistant line and the window on its result line alone,
   * so the two genuinely arrive apart.
   */
  async rememberContext(
    runId: string,
    reading: {
      contextTokens?: number | null;
      contextWindowTokens?: number | null;
    },
    txEm?: EntityManager,
  ): Promise<void> {
    const data: Partial<Run> = {};
    if (positive(reading.contextTokens)) {
      data.contextTokens = reading.contextTokens;
    }
    if (positive(reading.contextWindowTokens)) {
      data.contextWindowTokens = reading.contextWindowTokens;
    }
    if (Object.keys(data).length === 0) {
      return;
    }
    await this.getRepo(txEm).nativeUpdate({ id: runId }, data);
  }

  /**
   * Drop the run's context COUNT, because a compaction has just made it
   * describe a conversation that is gone.
   *
   * The one write that clears what {@link rememberContext} refuses to clear,
   * and it is a separate method for exactly that reason: there, an absent
   * figure means the reading said nothing about it; here, geniro knows the
   * figure is wrong. Only the count — the WINDOW is a property of the model
   * and a compaction does not change it, so clearing it would leave a later
   * numerator with nothing to divide by.
   *
   * Nulling rather than replacing, because there is no replacement to write: a
   * compaction geniro performed itself has not run yet (its summary reaches the
   * CLI on the NEXT turn), and one the CLI performed did not always say what it
   * left behind. Inventing the figure is the single thing a context meter must
   * never do.
   */
  async forgetContext(runId: string, txEm?: EntityManager): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { contextTokens: null },
    );
  }

  /**
   * Move the row's `updatedAt` and nothing else — "the user just did something
   * in this thread".
   *
   * The sidebar orders by that column inside its tier, and only a STATUS write
   * moved it: a message that starts a turn does (`running`), and a settle does,
   * but answering a question card does not — the verdict writes an item, and
   * items never touch the run row. So a thread parked on a question led the
   * list while it was asking and dropped to wherever its turn had STARTED the
   * moment it was answered. REPORTED as "как только я на него ответил, он
   * переместился обратно. То есть он прыгает!", and measured on the reporter's
   * own database: `CI336` was last written at 15:44:21, when its turn began,
   * with three threads written since — so answering sent it from first to
   * fourth.
   *
   * An explicit write rather than a no-op update: `onUpdate` fires when the ORM
   * flushes a CHANGED entity, and every write on this DAO is a `nativeUpdate`
   * that bypasses it — which is correct for the readings beside it (a context
   * figure is not activity) and exactly what this one exists to do on purpose.
   */
  async touch(
    runId: string,
    at: Date = new Date(),
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate({ id: runId }, { updatedAt: at });
  }

  /**
   * File the last reading taken from this run's agent before its process was
   * closed — see {@link Run.lastMetricsReading}.
   *
   * A bare `nativeUpdate` for `rememberContext`'s reason: nothing here needs
   * the row's other columns, and the caller holds a fork whose entity may
   * predate the session it just said goodbye to.
   */
  async rememberMetricsReading(
    runId: string,
    reading: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { lastMetricsReading: reading },
    );
  }

  /**
   * Write (or clear) the summary a geniro compaction owes this run's next turn
   * — see {@link Run.pendingContext}.
   *
   * A bare `nativeUpdate` for `rememberContext`'s reason: nothing here needs the
   * row's other columns, and the caller is holding a fork whose entity may
   * predate the turn that just settled.
   */
  async setPendingContext(
    runId: string,
    context: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: runId },
      { pendingContext: context },
    );
  }

  /**
   * Take the summary this run is owed, clearing it in the SAME statement, and
   * report what was taken.
   *
   * Read-then-clear rather than a read followed by a write: the column is
   * consumed exactly once, and two turns racing for it — a follow-up delivered
   * as another opens — would otherwise both read the summary and both prepend
   * it. `nativeUpdate` reports how many rows the predicate matched, so the
   * loser is told it took nothing rather than being handed a copy.
   */
  async takePendingContext(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    const repo = this.getRepo(txEm);
    const run = await repo.findOne(
      { id: runId },
      { disableIdentityMap: true, fields: ['pendingContext'] },
    );
    const pending = run?.pendingContext ?? null;
    if (pending === null) {
      return null;
    }
    const cleared = await repo.nativeUpdate(
      { id: runId, pendingContext: pending },
      { pendingContext: null },
    );
    return cleared > 0 ? pending : null;
  }

  /**
   * Chat runs stuck in a non-terminal `running` state — used by the boot-time
   * reconcile to close runs a crash / SIGKILL / restart left mid-turn.
   */
  async listRunningChats(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { workflowId: null, status: 'running' },
      { disableIdentityMap: true },
    );
  }

  /**
   * Release every run filed under a group — used when the group is deleted.
   *
   * The runs are UNTOUCHED apart from the column: a folder disappearing must
   * never take a conversation with it, which is the whole reason this exists
   * instead of a cascade. Both run kinds are swept, since the sidebar files
   * chats and workflow runs into the same groups.
   */
  async clearGroup(groupId: string, txEm?: EntityManager): Promise<number> {
    const em = txEm ?? this.em;
    const runs = await this.getRepo(txEm).find({ groupId });
    for (const run of runs) {
      run.groupId = null;
    }
    await em.flush();
    return runs.length;
  }

  /** Workflow runs (graph executions), newest first. */
  async listWorkflowRuns(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      { workflowId: { $ne: null } },
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /**
   * Workflow runs left in a non-terminal state by a crash / SIGKILL — the
   * graph executor's boot reconcile closes them (pending counts too: a
   * workflow run is created `running`, so anything non-terminal is orphaned).
   */
  async listRunningWorkflowRuns(txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      {
        workflowId: { $ne: null },
        status: { $in: ['pending', 'running'] },
      },
      { disableIdentityMap: true },
    );
  }
}

/**
 * A figure worth storing: a real number above zero.
 *
 * Zero is rejected as hard as null, and for the reason the renderer's own fold
 * states — a turn that reported `0` measured nothing, and both halves of the
 * ring read it as a denominator or a numerator that cannot be right.
 */
function positive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
