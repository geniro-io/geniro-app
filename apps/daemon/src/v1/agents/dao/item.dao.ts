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

  /**
   * Every `turn_complete` payload of a run, oldest first — what the thread's
   * spend is summed from.
   *
   * Its own query rather than a filter over `getByRun`: a long conversation's
   * transcript is thousands of rows of text and tool payloads, and the totals
   * need the handful that carry usage. Projected to `payload` alone for the
   * same reason.
   */
  async turnCompletePayloads(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string[]> {
    const rows = await this.getRepo(txEm).find(
      { runId, kind: 'turn_complete' },
      {
        orderBy: { seq: 'asc' },
        fields: ['payload'],
        disableIdentityMap: true,
      },
    );
    return rows.map((row) => row.payload);
  }

  /**
   * Every `turn_complete` row in the database, across all runs — what the usage
   * ledger's boot backfill sweeps to recover history recorded before it existed.
   *
   * Cross-run and carrying its row's identity, unlike {@link turnCompletePayloads},
   * which answers for ONE run and projects the payload alone. The backfill needs
   * `runId` + `seq` to key each turn idempotently and `createdAt` to date it, so
   * it cannot be expressed as a loop over that method.
   *
   * Projected to those five fields and filtered to the one kind that carries
   * usage: this runs once per boot, and hydrating full rows would pull every
   * conversation's text through memory to read a handful of integers. The kind
   * filter rides `Item`'s own `kind` index — added FOR this query, since every
   * other read here is scoped by `runId` and rides the composite index instead.
   */
  async allTurnCompleteRows(
    since?: Date,
    txEm?: EntityManager,
  ): Promise<
    Pick<Item, 'runId' | 'nodeId' | 'seq' | 'payload' | 'createdAt'>[]
  > {
    return this.getRepo(txEm).find(
      {
        kind: 'turn_complete',
        // `since` bounds the sweep to turns the ledger cannot already hold.
        // Without it every launch read the user's whole history to learn it had
        // nothing to do, so start-up cost grew forever.
        ...(since === undefined ? {} : { createdAt: { $gte: since } }),
      },
      {
        fields: ['runId', 'nodeId', 'seq', 'payload', 'createdAt'],
        disableIdentityMap: true,
      },
    );
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
