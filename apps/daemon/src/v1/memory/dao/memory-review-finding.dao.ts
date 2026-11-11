import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import type { AgentKind } from '../../runs/runs.types';
import { MemoryReviewFinding } from '../entity/memory-review-finding.entity';
import type {
  MemoryCheckOutcome,
  MemoryFindingKind,
  MemoryTextDatabase,
} from '../memory.types';
import { MEMORY_FINDING_KINDS } from '../memory.types';

/** One check of a pair, as it is stored; `memoryAId` < `memoryBId`. */
export interface MemoryCheckRecord {
  memoryAId: string;
  memoryBId: string;
  hashA: string;
  hashB: string;
  outcome: MemoryCheckOutcome;
  quoteA: string | null;
  quoteB: string | null;
  reason: string | null;
  agentKind: AgentKind;
  model: string | null;
}

/** A stored finding whose entries are both active at the texts it judged. */
export interface MemoryOpenFindingRow {
  id: string;
  memoryAId: string;
  memoryBId: string;
  hashA: string;
  hashB: string;
  kind: MemoryFindingKind;
  quoteA: string;
  quoteB: string;
  reason: string;
  agentKind: AgentKind;
  model: string | null;
  checkedAt: number;
}

@Injectable()
export class MemoryReviewFindingDao extends BaseDao<MemoryReviewFinding> {
  constructor(em: EntityManager) {
    super(em, MemoryReviewFinding);
  }

  /** Store each check, replacing an earlier one of the same pair; returns the ids by pair. */
  async record(
    checks: readonly MemoryCheckRecord[],
    at: Date,
    em: EntityManager = this.em,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const check of checks) {
      const row = await this.database(em)
        .insertInto('memory_review_findings')
        .values({
          id: randomUUID(),
          memory_a_id: check.memoryAId,
          memory_b_id: check.memoryBId,
          hash_a: check.hashA,
          hash_b: check.hashB,
          outcome: check.outcome,
          quote_a: check.quoteA,
          quote_b: check.quoteB,
          reason: check.reason,
          agent_kind: check.agentKind,
          model: check.model,
          checked_at: at.getTime(),
          dismissed_at: null,
          created_at: at.getTime(),
          updated_at: at.getTime(),
          deleted_at: null,
        })
        .onConflict((conflict) =>
          conflict.columns(['memory_a_id', 'memory_b_id']).doUpdateSet({
            hash_a: check.hashA,
            hash_b: check.hashB,
            outcome: check.outcome,
            quote_a: check.quoteA,
            quote_b: check.quoteB,
            reason: check.reason,
            agent_kind: check.agentKind,
            model: check.model,
            checked_at: at.getTime(),
            dismissed_at: null,
            updated_at: at.getTime(),
            deleted_at: null,
          }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      ids.set(pairKey(check.memoryAId, check.memoryBId), row.id);
    }
    return ids;
  }

  /** Every stored check's pair and the texts it judged, as `a\nb` → `hashA\nhashB`. */
  async checkedTexts(
    em: EntityManager = this.em,
  ): Promise<Map<string, string>> {
    const rows = await this.database(em)
      .selectFrom('memory_review_findings')
      .select(['memory_a_id', 'memory_b_id', 'hash_a', 'hash_b'])
      .where('deleted_at', 'is', null)
      .execute();
    return new Map(
      rows.map((row) => [
        pairKey(row.memory_a_id, row.memory_b_id),
        `${row.hash_a}\n${row.hash_b}`,
      ]),
    );
  }

  /**
   * Findings not dismissed whose entries are both active, newest check first,
   * with the hashes they judged: whether each text is still the one judged is
   * the caller's to compare.
   */
  async open(
    ids?: readonly string[],
    em: EntityManager = this.em,
  ): Promise<MemoryOpenFindingRow[]> {
    if (ids !== undefined && ids.length === 0) {
      return [];
    }
    let query = this.database(em)
      .selectFrom('memory_review_findings as f')
      .innerJoin('memories as a', 'a.id', 'f.memory_a_id')
      .innerJoin('memories as b', 'b.id', 'f.memory_b_id')
      .select([
        'f.id',
        'f.memory_a_id',
        'f.memory_b_id',
        'f.hash_a',
        'f.hash_b',
        'f.outcome',
        'f.quote_a',
        'f.quote_b',
        'f.reason',
        'f.agent_kind',
        'f.model',
        'f.checked_at',
      ])
      .where('f.deleted_at', 'is', null)
      .where('f.dismissed_at', 'is', null)
      .where('f.outcome', 'in', [...MEMORY_FINDING_KINDS])
      .where('a.deleted_at', 'is', null)
      .where('b.deleted_at', 'is', null)
      .where('a.status', '=', 'active')
      .where('b.status', '=', 'active');
    if (ids !== undefined) {
      query = query.where('f.id', 'in', [...ids]);
    }
    const rows = await query
      .orderBy('f.checked_at', 'desc')
      .orderBy('f.id')
      .execute();
    return rows.flatMap((row) =>
      isFindingKind(row.outcome) && row.quote_a !== null && row.quote_b !== null
        ? [
            {
              id: row.id,
              memoryAId: row.memory_a_id,
              memoryBId: row.memory_b_id,
              hashA: row.hash_a,
              hashB: row.hash_b,
              kind: row.outcome,
              quoteA: row.quote_a,
              quoteB: row.quote_b,
              reason: row.reason ?? '',
              agentKind: row.agent_kind,
              model: row.model,
              checkedAt: row.checked_at,
            },
          ]
        : [],
    );
  }

  /** Mark a finding as both entries true; false when there is no such finding. */
  async dismiss(
    id: string,
    at: Date,
    em: EntityManager = this.em,
  ): Promise<boolean> {
    const result = await this.database(em)
      .updateTable('memory_review_findings')
      .set({ dismissed_at: at.getTime(), updated_at: at.getTime() })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  private database(em = this.em) {
    return em.getKysely<MemoryTextDatabase>({ convertValues: false });
  }
}

/** A pair's key, its ids in stored order. */
export function pairKey(aId: string, bId: string): string {
  return `${aId}\n${bId}`;
}

function isFindingKind(outcome: string): outcome is MemoryFindingKind {
  return (MEMORY_FINDING_KINDS as readonly string[]).includes(outcome);
}
