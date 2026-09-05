import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Run } from '../../runs/entity/run.entity';
import type { ChatListScope } from '../chat.types';
import { positive } from '../utils/positive-figure';

@Injectable()
export class RunDao extends BaseDao<Run> {
  constructor(em: EntityManager) {
    super(em, Run);
  }

  /**
   * Single-agent chat runs (no workflow), newest first, filtered by how much
   * of the archive the caller asked for.
   *
   * `all` states NO condition on `archivedAt` rather than a condition matching
   * both sides — an `$in` over null and non-null is the same rows written as a
   * predicate SQL cannot use an index for, and one that a nullable column
   * makes easy to get subtly wrong.
   */
  async listChats(scope: ChatListScope, txEm?: EntityManager): Promise<Run[]> {
    return this.getRepo(txEm).find(
      {
        workflowId: null,
        ...(scope === 'all'
          ? {}
          : { archivedAt: scope === 'archived' ? { $ne: null } : null }),
      },
      // Read-only list paths: skip identity-map tracking so a long run history
      // doesn't accumulate managed entities in the forked EM (see item.dao).
      { orderBy: { createdAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /**
   * Every ARCHIVED run shelved before `cutoff`, oldest first — both kinds.
   *
   * TWO columns rather than whole rows: every one of them is about to be
   * destroyed, so hydrating entities buys nothing and a long archive would load
   * its whole history into the forked EM. The `workflowId` rides along because
   * the sweep has to know which teardown a run needs, and asking per id would
   * be a second query for a column this one already touches.
   *
   * It answered CHAT runs alone until workflow runs became archivable — a limit
   * that then meant the retention window silently did not cover half the shelf.
   *
   * Oldest FIRST, which is the reverse of every other listing here and is the
   * one ordering that degrades well: a sweep interrupted part-way — the daemon
   * quits, the disk fills — has removed the runs furthest past the retention
   * window, so the next sweep resumes rather than starting over on rows it has
   * already reached.
   */
  async archivedRunsBefore(
    cutoff: Date,
    txEm?: EntityManager,
  ): Promise<{ id: string; workflowId: string | null }[]> {
    const rows = await this.getRepo(txEm).find(
      { archivedAt: { $ne: null, $lte: cutoff } },
      {
        fields: ['id', 'workflowId'],
        orderBy: { archivedAt: 'asc' },
        disableIdentityMap: true,
      },
    );
    return rows.map((run) => ({ id: run.id, workflowId: run.workflowId }));
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
   * Workflow runs that actually CARRY a title — the only rows the title
   * backfill can act on.
   *
   * The predicate is in SQL and the read is projected, both for the same
   * reason: this runs on the pre-listen boot path, where hydrating a whole
   * install's workflow-run history to discard most of it is latency every
   * launch pays. A run whose title is already null can never match the sweep's
   * own predicate, so the database is the right place to drop it.
   */
  async listTitledWorkflowRuns(
    txEm?: EntityManager,
  ): Promise<Pick<Run, 'id' | 'title' | 'workflowId'>[]> {
    return this.getRepo(txEm).find(
      { workflowId: { $ne: null }, title: { $ne: null } },
      {
        fields: ['id', 'title', 'workflowId'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * Clear a run's title, but only while it still reads exactly as `expected`.
   *
   * Its own method rather than a nullable `title` on {@link retitle}: that one
   * is how a run gets NAMED, and widening it would put "erase this run's name"
   * one argument away from every call site that writes one. The compare is the
   * same guard for the same reason — a user's rename landing between the read
   * and the write must win.
   */
  async forgetTitle(
    runId: string,
    expected: string,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const written = await this.getRepo(txEm).nativeUpdate(
      { id: runId, title: expected },
      { title: null },
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
   * Add one turn's worked milliseconds and tool count to this chat's running
   * totals — the run-level twin of `NodeStateDao.rememberWork`, and the
   * accumulating counterpart of {@link rememberContext} above.
   *
   * That one records a LEVEL and overwrites; these are TOTALS, so every write
   * is a fraction of the answer and overwriting would report the last turn's
   * work as the chat's whole history.
   *
   * Read-modify-write rather than a SQL increment, on the same reasoning its
   * node-level twin states: a chat's turns are serialized — one turn per run at
   * a time, enforced by the session registry's own busy check — so the two
   * writes that can touch this row never overlap. A second concurrent writer
   * would need a real increment.
   *
   * Neither figure is cleared by a turn that omits it: a CLI reporting no
   * timing must not erase the time already counted, which is the ordinary case
   * on every ACP agent.
   */
  async rememberWork(
    runId: string,
    workedMs: number | null,
    toolCalls: number | null,
    txEm?: EntityManager,
  ): Promise<void> {
    if (!positive(workedMs) && !positive(toolCalls)) {
      return;
    }
    const row = await this.getRepo(txEm).findOne(
      { id: runId },
      { disableIdentityMap: true },
    );
    if (row === null) {
      return;
    }
    const data: Partial<Run> = {};
    if (positive(workedMs)) {
      data.workedMs = (row.workedMs ?? 0) + workedMs;
    }
    if (positive(toolCalls)) {
      data.toolCalls = (row.toolCalls ?? 0) + toolCalls;
    }
    await this.getRepo(txEm).nativeUpdate({ id: runId }, data);
  }

  /**
   * The run's CURRENT worked-time and tool-count totals.
   *
   * Read for the settle announce alone (`writeRunStatus`), which is what keeps
   * a client's copy of these columns from freezing at the moment it fetched the
   * run. They are TOTALS the daemon accumulates per turn, so unlike `status` or
   * `title` a client cannot derive the new value from the event that changed
   * it — and nothing else refreshes the row between full listings.
   *
   * `disableIdentityMap` for the reason {@link rememberWork} needs it: that
   * write is a `nativeUpdate`, which the identity map never sees, so a cached
   * entity would answer with the totals as they stood before this very turn.
   */
  async readWork(
    runId: string,
    txEm?: EntityManager,
  ): Promise<{ workedMs: number | null; toolCalls: number | null } | null> {
    const row = await this.getRepo(txEm).findOne(
      { id: runId },
      { disableIdentityMap: true },
    );
    if (row === null) {
      return null;
    }
    return { workedMs: row.workedMs, toolCalls: row.toolCalls };
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

  /**
   * Workflow runs (graph executions), newest first, filtered by how much of the
   * archive the caller asked for.
   *
   * The archive predicate is {@link listChats}' own, down to `all` stating no
   * condition at all — the two listings feed ONE sidebar, so a scope that meant
   * different things on either side of it would put a shelved workflow run in a
   * view the user opened to see only live work.
   */
  async listWorkflowRuns(
    scope: ChatListScope,
    txEm?: EntityManager,
  ): Promise<Run[]> {
    return this.getRepo(txEm).find(
      {
        workflowId: { $ne: null },
        ...(scope === 'all'
          ? {}
          : { archivedAt: scope === 'archived' ? { $ne: null } : null }),
      },
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
