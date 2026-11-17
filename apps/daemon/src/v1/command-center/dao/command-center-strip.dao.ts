import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { SPAN_ROW_KINDS } from '../../agents/utils/active-spans';
import { Item } from '../../runs/entity/item.entity';
import type { ItemKind } from '../../runs/runs.types';
import type { StripRow } from '../utils/thread-strip-fold';

/** Every kind a strip reads besides the user's messages. */
const STRIP_KINDS: readonly ItemKind[] = [
  ...SPAN_ROW_KINDS,
  'error',
  'stage_change',
];

const STRIP_FIELDS = [
  'seq',
  'kind',
  'role',
  'memberId',
  'createdAt',
  'payload',
] as const;

/** The transcript reads behind the command center's timeline strips. */
@Injectable()
export class CommandCenterStripDao {
  constructor(private readonly em: EntityManager) {}

  /**
   * The seq of the run's newest row written before `at`, or -1 — where a
   * strip starting at `at` begins reading. Walks the `(runId, seq)` index from
   * the newest end, so the cost is the rows inside the strip, not the run.
   */
  async lastSeqBefore(
    runId: string,
    at: Date,
    txEm?: EntityManager,
  ): Promise<number> {
    const [row] = await (txEm ?? this.em.fork()).find(
      Item,
      { runId, createdAt: { $lt: at } },
      {
        orderBy: { seq: 'desc' },
        limit: 1,
        fields: ['seq'],
        disableIdentityMap: true,
      },
    );
    return row?.seq ?? -1;
  }

  /** The rows a strip folds, after `afterSeq`, in seq order. */
  async stripRows(
    runId: string,
    afterSeq: number,
    txEm?: EntityManager,
  ): Promise<StripRow[]> {
    const em = txEm ?? this.em.fork();
    const [structural, userMessages] = await Promise.all([
      em.find(
        Item,
        { runId, kind: { $in: [...STRIP_KINDS] }, seq: { $gt: afterSeq } },
        { fields: [...STRIP_FIELDS], disableIdentityMap: true },
      ),
      em.find(
        Item,
        {
          runId,
          kind: 'message',
          role: 'user',
          memberId: null,
          seq: { $gt: afterSeq },
        },
        { fields: [...STRIP_FIELDS], disableIdentityMap: true },
      ),
    ]);
    return [...structural, ...userMessages]
      .sort((a, b) => a.seq - b.seq)
      .map((item) => ({
        kind: item.kind,
        role: item.role,
        memberId: item.memberId,
        createdAt: item.createdAt,
        payload: item.payload,
      }));
  }

  /** When the run's row at `seq` was written, or null. */
  async timeAtSeq(
    runId: string,
    seq: number,
    txEm?: EntityManager,
  ): Promise<Date | null> {
    const row = await (txEm ?? this.em.fork()).findOne(
      Item,
      { runId, seq },
      { fields: ['createdAt'], disableIdentityMap: true },
    );
    return row?.createdAt ?? null;
  }
}
