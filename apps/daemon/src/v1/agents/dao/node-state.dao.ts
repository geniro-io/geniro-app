import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { NodeState } from '../../runs/entity/node-state.entity';
import type { AgentKind, NodeStatus } from '../../runs/runs.types';
import { positive } from '../utils/positive-figure';

@Injectable()
export class NodeStateDao extends BaseDao<NodeState> {
  constructor(em: EntityManager) {
    super(em, NodeState);
  }

  async getByRunNode(
    runId: string,
    nodeId: string,
    txEm?: EntityManager,
  ): Promise<NodeState | null> {
    return this.getRepo(txEm).findOne({ runId, nodeId });
  }

  async listByRun(runId: string, txEm?: EntityManager): Promise<NodeState[]> {
    // Read-only snapshot path — no identity-map tracking needed (see item.dao).
    return this.getRepo(txEm).find({ runId }, { disableIdentityMap: true });
  }

  /** Seed one `pending` row per graph node when a workflow run starts. */
  async createPending(
    runId: string,
    nodeId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em;
    this.getRepo(txEm).create(
      { runId, nodeId, status: 'pending' },
      { partial: true },
    );
    await em.flush();
  }

  /**
   * Transition a node's lifecycle status (composite PK, so `BaseDao.updateById`
   * does not apply). An absent patch field leaves the stored value untouched.
   */
  async setStatus(
    runId: string,
    nodeId: string,
    patch: {
      status: NodeStatus;
      startedAt?: number;
      endedAt?: number;
      error?: string | null;
      /** Stamped at turn start so run history survives workflow YAML edits. */
      agentKind?: AgentKind;
      /** Stamped beside {@link agentKind}, and for the same reason. */
      model?: string | null;
    },
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em;
    const repo = this.getRepo(txEm);
    const existing = await repo.findOne({ runId, nodeId });
    if (existing) {
      existing.status = patch.status;
      if (patch.startedAt !== undefined) {
        existing.startedAt = patch.startedAt;
      }
      if (patch.endedAt !== undefined) {
        existing.endedAt = patch.endedAt;
      }
      if (patch.error !== undefined) {
        existing.error = patch.error;
      }
      if (patch.agentKind !== undefined) {
        existing.agentKind = patch.agentKind;
      }
    } else {
      repo.create(
        {
          runId,
          nodeId,
          status: patch.status,
          startedAt: patch.startedAt ?? null,
          endedAt: patch.endedAt ?? null,
          error: patch.error ?? null,
          agentKind: patch.agentKind ?? null,
        },
        { partial: true },
      );
    }
    await em.flush();
  }

  /**
   * Create or update the per-node state, persisting the CLI session id used for
   * `--resume`. Composite-PK entity, so `BaseDao.getById` (which keys on `id`)
   * does not apply — this upsert keys on (runId, nodeId).
   */
  async saveSessionId(
    runId: string,
    nodeId: string,
    agentSessionId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em;
    const repo = this.getRepo(txEm);
    const existing = await repo.findOne({ runId, nodeId });
    if (existing) {
      existing.agentSessionId = agentSessionId;
    } else {
      repo.create(
        { runId, nodeId, status: 'running', agentSessionId },
        { partial: true },
      );
    }
    await em.flush();
  }

  /**
   * Record this node's latest context reading — the per-node twin of
   * `RunDao.rememberContext`, and it follows that method's rules exactly.
   *
   * A bare `nativeUpdate` rather than `updateById`/`findOne`+flush: this fires
   * once per main-thread model response, so it must not read the row, hydrate
   * an entity and flush it — nothing here needs the row's other columns, and
   * loading them would put a whole node-state entity through the identity map
   * several times a minute.
   *
   * Neither figure is ever cleared by a reading that OMITS it: a
   * `context_progress` carries a count with no window and a `turn_complete`
   * carries the window, so writing the absent half as null would have each
   * erase what the other had just recorded. A non-positive count is not a
   * measurement and is ignored for the same reason it is on the live plane.
   *
   * It writes nothing when no row exists yet, unlike `saveSessionId` beside it:
   * a reading is about a turn, and a turn always has its `createPending` row by
   * the time one arrives — creating one HERE would invent a node with a status
   * nobody chose. A `nativeUpdate` against a non-existent `(runId, nodeId)`
   * matches nothing and writes nothing, which preserves that guard without a
   * read.
   */
  async rememberContext(
    runId: string,
    nodeId: string,
    contextTokens: number | null,
    contextWindowTokens: number | null,
    txEm?: EntityManager,
  ): Promise<void> {
    const data: Partial<NodeState> = {};
    if (positive(contextTokens)) {
      data.contextTokens = contextTokens;
    }
    if (positive(contextWindowTokens)) {
      data.contextWindowTokens = contextWindowTokens;
    }
    if (Object.keys(data).length === 0) {
      return;
    }
    await this.getRepo(txEm).nativeUpdate({ runId, nodeId }, data);
  }

  /**
   * Advance how far this node's conversation has been PRICED — the watermark
   * behind the cursor spend accumulator.
   *
   * A bare `nativeUpdate` on {@link rememberContext}'s rules: the poll writes
   * one of these per conversation it counted, and nothing here needs the row's
   * other columns.
   *
   * It only ever moves FORWARD. The poll advances it to the newest event it
   * actually folded, so a window that returned nothing new leaves it alone; the
   * guard makes that hold even if a caller passed an older mark, because a
   * watermark that went backwards would count a stretch of events twice.
   */
  async rememberCursorSpendThrough(
    runId: string,
    nodeId: string,
    throughMs: number,
    txEm?: EntityManager,
  ): Promise<void> {
    if (!positive(throughMs)) {
      return;
    }
    await this.getRepo(txEm).nativeUpdate(
      {
        runId,
        nodeId,
        $or: [
          { cursorSpendThroughMs: null },
          { cursorSpendThroughMs: { $lt: throughMs } },
        ],
      },
      { cursorSpendThroughMs: throughMs },
    );
  }

  /**
   * Forget the CLI session this node was resuming, so the next turn starts a
   * fresh one.
   *
   * The mechanism behind a geniro-performed compaction
   * (`AgentGeniroCommand.replacesSession`): the conversation shrinks exactly
   * when the id the CLI resumes stops being recorded. A row that does not exist
   * is already in that state, which is why this writes nothing rather than
   * creating one — there is no session to forget.
   */
  async clearSessionId(
    runId: string,
    nodeId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { runId, nodeId },
      { agentSessionId: null },
    );
  }
}
