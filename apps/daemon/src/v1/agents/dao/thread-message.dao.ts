import { EntityManager, type FilterQuery } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { ThreadMessage } from '../../runs/entity/thread-message.entity';
import type { ThreadMessageReason } from '../chat.types';

/** What a turn still owes and a wake may open one for. */
const OWED = {
  status: 'waiting',
  wake: true,
  $or: [{ reason: null }, { reason: 'running_turn' }, { reason: 'question' }],
} satisfies FilterQuery<ThreadMessage>;

/** `thread_messages` — the mailbox between threads. */
@Injectable()
export class ThreadMessageDao extends BaseDao<ThreadMessage> {
  constructor(em: EntityManager) {
    super(em, ThreadMessage);
  }

  /** A thread's waiting messages, oldest first. */
  async listWaiting(
    toRunId: string,
    txEm?: EntityManager,
  ): Promise<ThreadMessage[]> {
    return this.getRepo(txEm ?? this.em.fork()).find(
      { toRunId, status: 'waiting' },
      {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        disableIdentityMap: true,
      },
    );
  }

  /** Messages a turn is owed to carry and a wake may still open it for. */
  async listOwed(
    toRunId: string,
    txEm?: EntityManager,
  ): Promise<ThreadMessage[]> {
    return this.getRepo(txEm ?? this.em.fork()).find(
      { toRunId, ...OWED },
      {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        disableIdentityMap: true,
      },
    );
  }

  /** The threads holding a message {@link listOwed} would answer. */
  async owedRunIds(txEm?: EntityManager): Promise<string[]> {
    const rows = await this.getRepo(txEm ?? this.em.fork()).find(OWED, {
      fields: ['toRunId'],
      disableIdentityMap: true,
    });
    return [...new Set(rows.map((row) => row.toRunId))];
  }

  async countWaiting(toRunId: string, txEm?: EntityManager): Promise<number> {
    return this.count({ toRunId, status: 'waiting' }, txEm ?? this.em.fork());
  }

  /** What one sender sent one thread since `since`. */
  async sentSince(
    fromRunId: string,
    toRunId: string,
    since: Date,
    txEm?: EntityManager,
  ): Promise<ThreadMessage[]> {
    return this.getRepo(txEm ?? this.em.fork()).find(
      { fromRunId, toRunId, createdAt: { $gte: since } },
      { disableIdentityMap: true },
    );
  }

  /** Wakes spent on a thread's messages last woken since `since`. */
  async sumWakesSince(
    toRunId: string,
    since: Date,
    txEm?: EntityManager,
  ): Promise<number> {
    const rows = await this.getRepo(txEm ?? this.em.fork()).find(
      { toRunId, wokeAt: { $gte: since } },
      { fields: ['wakes'], disableIdentityMap: true },
    );
    return rows.reduce((sum, row) => sum + row.wakes, 0);
  }

  /**
   * Messages joined into a thread's running turns since `since`. Only a join
   * stamps a delivery id, and a dropped join loses it again.
   */
  async countJoinedSince(
    toRunId: string,
    since: Date,
    txEm?: EntityManager,
  ): Promise<number> {
    return this.count(
      {
        toRunId,
        status: 'delivered',
        deliveryId: { $ne: null },
        deliveredAt: { $gte: since },
      },
      txEm ?? this.em.fork(),
    );
  }

  async setReason(
    ids: readonly string[],
    reason: ThreadMessageReason | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await (txEm ?? this.em.fork()).nativeUpdate(
      ThreadMessage,
      { id: { $in: [...ids] }, status: 'waiting' },
      { reason },
    );
  }

  async markWoken(
    id: string,
    wakes: number,
    at: Date,
    txEm?: EntityManager,
  ): Promise<void> {
    await (txEm ?? this.em.fork()).nativeUpdate(
      ThreadMessage,
      { id },
      { wokeAt: at, wakes, reason: null },
    );
  }

  async markDelivered(
    ids: readonly string[],
    deliveryId: string | null,
    at: Date,
    txEm?: EntityManager,
  ): Promise<void> {
    await (txEm ?? this.em.fork()).nativeUpdate(
      ThreadMessage,
      { id: { $in: [...ids] }, status: 'waiting' },
      { status: 'delivered', deliveredAt: at, deliveryId, reason: null },
    );
  }

  /** The delivered rows a dropped delivery named. */
  async listByDeliveryIds(
    deliveryIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<ThreadMessage[]> {
    return this.getRepo(txEm ?? this.em.fork()).find(
      { deliveryId: { $in: [...deliveryIds] }, status: 'delivered' },
      { disableIdentityMap: true },
    );
  }

  async returnToWaiting(
    ids: readonly string[],
    txEm?: EntityManager,
  ): Promise<void> {
    await (txEm ?? this.em.fork()).nativeUpdate(
      ThreadMessage,
      { id: { $in: [...ids] } },
      {
        status: 'waiting',
        reason: 'running_turn',
        deliveredAt: null,
        deliveryId: null,
      },
    );
  }

  async cancel(ids: readonly string[], txEm?: EntityManager): Promise<void> {
    await (txEm ?? this.em.fork()).nativeUpdate(
      ThreadMessage,
      { id: { $in: [...ids] } },
      { status: 'cancelled', reason: null },
    );
  }

  /** Every row addressed to a thread being deleted. */
  async hardDeleteAddressedTo(
    toRunId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await (txEm ?? this.em.fork()).nativeDelete(ThreadMessage, { toRunId });
  }
}
