import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Item } from '../../runs/entity/item.entity';
import { messageText } from '../utils/message-preview';

@Injectable()
export class ItemDao extends BaseDao<Item> {
  constructor(em: EntityManager) {
    super(em, Item);
  }

  /**
   * Ordered transcript for a run. `afterSeq` is the replay cursor: pass the
   * highest seq the client has already rendered to fetch only newer items
   * (default -1 returns the whole transcript, since seq starts at 0).
   */
  async getByRun(
    runId: string,
    afterSeq = -1,
    txEm?: EntityManager,
  ): Promise<Item[]> {
    return this.getRepo(txEm).find(
      { runId, seq: { $gt: afterSeq } },
      // Read-only replay path: skip identity-map tracking so a long transcript
      // doesn't accumulate managed entities in the forked EM.
      { orderBy: { seq: 'asc' }, disableIdentityMap: true },
    );
  }

  /**
   * Text of the latest `message` item per run — the chat list's preview line.
   * Two bounded queries, never the full transcripts: first the (runId, seq)
   * pairs of message items (integers + ids only, no payloads), reduced to the
   * per-run head in memory, then just those head rows' payloads. Runs with no
   * message items (or a non-text payload) are simply absent from the map.
   */
  async latestMessageTextPerRun(
    runIds: string[],
    txEm?: EntityManager,
  ): Promise<Map<string, string>> {
    if (runIds.length === 0) {
      return new Map();
    }
    const repo = this.getRepo(txEm);
    const heads = await repo.find(
      { runId: { $in: runIds }, kind: 'message' },
      { fields: ['runId', 'seq'], disableIdentityMap: true },
    );
    const headSeq = new Map<string, number>();
    for (const head of heads) {
      const prev = headSeq.get(head.runId);
      if (prev === undefined || head.seq > prev) {
        headSeq.set(head.runId, head.seq);
      }
    }
    if (headSeq.size === 0) {
      return new Map();
    }
    const rows = await repo.find(
      { $or: [...headSeq].map(([runId, seq]) => ({ runId, seq })) },
      { fields: ['runId', 'payload'], disableIdentityMap: true },
    );
    const previews = new Map<string, string>();
    for (const row of rows) {
      const text = messageText(row.payload);
      if (text !== null) {
        previews.set(row.runId, text);
      }
    }
    return previews;
  }

  /** Highest seq persisted for a run, or -1 when the run has no items yet. */
  async maxSeq(runId: string, txEm?: EntityManager): Promise<number> {
    // Project ONLY `seq` — this runs on every sendMessage; hydrating the full
    // newest Item (incl. its text payload) just to read one integer is wasteful.
    const last = await this.getRepo(txEm).findOne(
      { runId },
      { orderBy: { seq: 'desc' }, fields: ['seq'], disableIdentityMap: true },
    );
    return last ? last.seq : -1;
  }
}
