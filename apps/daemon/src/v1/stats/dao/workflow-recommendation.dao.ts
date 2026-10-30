import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { WorkflowRecommendation } from '../entity/workflow-recommendation.entity';
import type {
  FiledRecommendation,
  WorkflowRecommendationRow,
} from '../stats.types';

/** `workflow_recommendations` as SQLite stores it; dates are epoch milliseconds, since value conversion is off. */
interface RecommendationDatabase {
  workflow_recommendations: {
    id: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    slug: string;
    chat_run_id: string;
    chat_kind: WorkflowRecommendation['chatKind'];
    card_seq: number;
    filed_at: number;
    library_version: string | null;
    item_id: string;
    target: string;
    territory: string;
    kind: string;
    location: string;
    title: string;
    change: string;
    root_cause: string;
    minutes_saved: number;
    confidence: number;
    risk: string;
    selected_at: number | null;
    outcome: string | null;
    outcome_note: string | null;
    outcome_at: number | null;
    outcome_seq: number | null;
  };
}

function dateOf(ms: number | null): Date | null {
  return ms === null ? null : new Date(Number(ms));
}

/**
 * The ledger of a workflow's recommendations (see the entity). Every write is
 * idempotent, so the live copy and the boot sweep may both reach one row: a
 * card is filed once, an item's first selection stands, and a mark only ever
 * moves forward by the seq of the row that made it.
 */
@Injectable()
export class WorkflowRecommendationDao extends BaseDao<WorkflowRecommendation> {
  constructor(em: EntityManager) {
    super(em, WorkflowRecommendation);
  }

  /** File a card's items; an item already filed is left as it is. */
  async file(
    items: readonly FiledRecommendation[],
    txEm?: EntityManager,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const now = Date.now();
    await (txEm ?? this.em.fork())
      .getKysely<RecommendationDatabase>({ convertValues: false })
      .insertInto('workflow_recommendations')
      .values(
        items.map((item) => ({
          id: randomUUID(),
          created_at: now,
          updated_at: now,
          deleted_at: null,
          slug: item.slug,
          chat_run_id: item.chatRunId,
          chat_kind: item.chatKind,
          card_seq: item.cardSeq,
          filed_at: item.filedAt.getTime(),
          library_version: item.libraryVersion,
          item_id: item.itemId,
          target: item.target,
          territory: item.territory,
          kind: item.kind,
          location: item.location,
          title: item.title,
          change: item.change,
          root_cause: item.rootCause,
          minutes_saved: item.minutesSaved,
          confidence: item.confidence,
          risk: item.risk,
          selected_at: null,
          outcome: null,
          outcome_note: null,
          outcome_at: null,
          outcome_seq: null,
        })),
      )
      .onConflict((conflict) =>
        conflict.columns(['chat_run_id', 'card_seq', 'item_id']).doNothing(),
      )
      .execute();
  }

  /** Mark these items of one card selected at `at`, unless an earlier Apply already did. */
  async markSelected(
    chatRunId: string,
    cardSeq: number,
    itemIds: readonly string[],
    at: Date,
    txEm?: EntityManager,
  ): Promise<void> {
    if (itemIds.length === 0) {
      return;
    }
    await (txEm ?? this.em.fork())
      .getKysely<RecommendationDatabase>({ convertValues: false })
      .updateTable('workflow_recommendations')
      .set({ selected_at: at.getTime(), updated_at: Date.now() })
      .where('chat_run_id', '=', chatRunId)
      .where('card_seq', '=', cardSeq)
      .where('item_id', 'in', [...itemIds])
      .where((eb) =>
        eb.or([
          eb('selected_at', 'is', null),
          eb('selected_at', '>', at.getTime()),
        ]),
      )
      .execute();
  }

  /** Record one item's mark, unless a mark from a later row is already recorded. */
  async markOutcome(
    chatRunId: string,
    cardSeq: number,
    mark: { itemId: string; outcome: string; note: string | null },
    source: { seq: number; at: Date },
    txEm?: EntityManager,
  ): Promise<void> {
    await (txEm ?? this.em.fork())
      .getKysely<RecommendationDatabase>({ convertValues: false })
      .updateTable('workflow_recommendations')
      .set({
        outcome: mark.outcome,
        outcome_note: mark.note,
        outcome_at: source.at.getTime(),
        outcome_seq: source.seq,
        updated_at: Date.now(),
      })
      .where('chat_run_id', '=', chatRunId)
      .where('card_seq', '=', cardSeq)
      .where('item_id', '=', mark.itemId)
      .where((eb) =>
        eb.or([
          eb('outcome_seq', 'is', null),
          eb('outcome_seq', '<', source.seq),
        ]),
      )
      .execute();
  }

  /** Every item filed about one workflow, oldest card first, in card order. */
  async rowsOf(
    slug: string,
    txEm?: EntityManager,
  ): Promise<WorkflowRecommendationRow[]> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<RecommendationDatabase>({ convertValues: false })
      .selectFrom('workflow_recommendations')
      .selectAll()
      .where('slug', '=', slug)
      .where('deleted_at', 'is', null)
      .orderBy('filed_at', 'asc')
      .orderBy('chat_run_id', 'asc')
      .orderBy('card_seq', 'asc')
      .execute();
    return rows.map((row) => ({
      slug: row.slug,
      chatRunId: row.chat_run_id,
      chatKind: row.chat_kind,
      cardSeq: row.card_seq,
      filedAt: new Date(Number(row.filed_at)),
      libraryVersion: row.library_version,
      itemId: row.item_id,
      target: row.target,
      territory: row.territory,
      kind: row.kind,
      location: row.location,
      title: row.title,
      change: row.change,
      rootCause: row.root_cause,
      minutesSaved: row.minutes_saved,
      confidence: row.confidence,
      risk: row.risk,
      selectedAt: dateOf(row.selected_at),
      outcome: row.outcome,
      outcomeNote: row.outcome_note,
      outcomeAt: dateOf(row.outcome_at),
      outcomeSeq: row.outcome_seq,
    }));
  }
}
