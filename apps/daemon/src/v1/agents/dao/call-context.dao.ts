import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { CallContext } from '../../runs/entity/call-context.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { positive } from '../utils/positive-figure';

/**
 * How many call rings one run's snapshot may carry.
 *
 * The listing feeds the nodes route, which a client reads WHOLE on every
 * reconnect — so its size is a per-reconnect cost, not a stored one. Nothing
 * else bounds it: a row is written per agent-to-agent call and never deleted
 * until the run is, so a long-lived workflow that fans out on a loop grows this
 * without limit, and every reconnect pays for the whole history.
 *
 * Newest-first, because that is the half a client can still use: a ring is
 * drawn against a call thread in the transcript, and the transcript itself
 * opens on a window (`HISTORY_PAGE`). A reading older than the oldest loaded
 * thread has nothing to be drawn on. The cap is deliberately far above that
 * window rather than equal to it — the two are not the same measure, and a
 * client that has paged back should still find rings waiting.
 */
export const CALL_CONTEXT_SNAPSHOT_LIMIT = 500;

@Injectable()
export class CallContextDao extends BaseDao<CallContext> {
  constructor(em: EntityManager) {
    super(em, CallContext);
  }

  /**
   * One run's call readings, newest {@link CALL_CONTEXT_SNAPSHOT_LIMIT} first
   * and returned oldest-first.
   *
   * The limit is applied to the NEWEST rows and the result is then flipped, so
   * a truncated snapshot drops the oldest calls rather than the most recent
   * ones, while callers still read the array in the order the calls happened.
   */
  async listByRun(runId: string, txEm?: EntityManager): Promise<CallContext[]> {
    // Read-only snapshot path — no identity-map tracking needed (see item.dao).
    const newestFirst = await this.getRepo(txEm).find(
      { runId },
      {
        disableIdentityMap: true,
        orderBy: { createdAt: 'desc' },
        limit: CALL_CONTEXT_SNAPSHOT_LIMIT,
      },
    );
    return newestFirst.reverse();
  }

  /**
   * Record one call's latest context reading — the per-call twin of
   * `NodeStateDao.rememberContext`, and it follows that method's rules.
   *
   * It differs in one forced way: this one CREATES the row when none exists. A
   * node has its `createPending` row before any reading arrives, so the node
   * twin can be a bare `nativeUpdate` that writes nothing for an unknown node;
   * a call has no such seed, so that shape here would match nothing and discard
   * every per-call reading ever taken.
   *
   * It is safe against itself only because the executor's durable writes for
   * one run ride a serialized queue, so two readings for one `(runId, callId)`
   * are never in flight together — a caller outside that chain would race the
   * primary key.
   *
   * The create is also gated on the calling NODE still having a `node_state`
   * row, which is what keeps a write straggling past a run teardown from
   * INSERTING an orphan where the node twin's update would simply have matched
   * nothing. The node is the right thing to ask about rather than the run, on
   * two counts. It is the stricter question — `RunTeardownService.purge`
   * destroys node states BEFORE call contexts, so there is a window where the
   * `runs` row still stands and a row written against it is already dead. And
   * it is the honest one: `GraphExecutorService.getNodeStates` builds its
   * response by mapping over node-state rows and looking calls up beside them,
   * so a call row whose node has no state row is unreachable BY CONSTRUCTION,
   * not merely by accident of what else was deleted.
   *
   * It narrows rather than closes: a teardown landing between this check and
   * the insert still orphans the row. That residue is the same one every writer
   * here carries — `Item.runId` has no FK either, and `purge` says so — and
   * closing it properly means a transaction spanning both, not a longer guard.
   */
  async rememberContext(
    runId: string,
    callId: string,
    nodeId: string,
    contextTokens: number | null,
    contextWindowTokens: number | null,
    txEm?: EntityManager,
  ): Promise<void> {
    const data: Partial<CallContext> = {};
    if (positive(contextTokens)) {
      data.contextTokens = contextTokens;
    }
    if (positive(contextWindowTokens)) {
      data.contextWindowTokens = contextWindowTokens;
    }
    if (Object.keys(data).length === 0) {
      return;
    }
    const em = txEm ?? this.em;
    const repo = this.getRepo(txEm);
    const written = await repo.nativeUpdate({ runId, callId }, data);
    if (written > 0) {
      return;
    }
    // The call's FIRST reading, and the only branch that can insert. Paid once
    // per call rather than per reading, which is why the check sits here.
    if ((await em.count(NodeState, { runId, nodeId })) === 0) {
      return;
    }
    repo.create({ runId, callId, nodeId, ...data }, { partial: true });
    await em.flush();
  }
}
