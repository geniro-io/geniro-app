import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { ThreadMessage } from '../../runs/entity/thread-message.entity';
import type { ThreadMessageReason } from '../chat.types';

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
      {
        toRunId,
        status: 'waiting',
        wake: true,
        $or: [{ reason: null }, { reason: 'running_turn' }],
      },
      {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        disableIdentityMap: true,
      },
    );
  }

  /** The threads holding a message {@link listOwed} would answer. */
  async owedRunIds(txEm?: EntityManager): Promise<string[]> {
    const rows = await this.getRepo(txEm ?? this.em.fork()).find(
      {
        status: 'waiting',
        wake: true,
        $or: [{ reason: null }, { reason: 'running_turn' }],
      },
      { fields: ['toRunId'], disableIdentityMap: true },
    );
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

  async countWakesSince(
    toRunId: string,
    since: Date,
    txEm?: EntityManager,
  ): Promise<number> {
    return this.count(
      { toRunId, wokeAt: { $gte: since } },
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

  async markWoken(id: string, at: Date, txEm?: EntityManager): Promise<void> {
    await (txEm ?? this.em.fork()).nativeUpdate(
      ThreadMessage,
      { id },
      { wokeAt: at, reason: null },
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
