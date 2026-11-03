import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import {
  MEMBER_VERDICTS,
  type MemberVerdict,
  type RecommendationEvidence,
  RecommendationEvidenceSchema,
} from '../../agents/chat.types';
import { MemberAssessmentRecord } from '../entity/member-assessment.entity';
import type { MemberAssessmentRow } from '../stats.types';

/** `member_assessments` as SQLite stores it; dates are epoch milliseconds, since value conversion is off. */
interface AssessmentDatabase {
  member_assessments: {
    id: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    slug: string;
    chat_run_id: string;
    chat_kind: MemberAssessmentRecord['chatKind'];
    card_seq: number;
    filed_at: number;
    library_version: string | null;
    runs: number;
    run_ids: string | null;
    member_id: string;
    usefulness: number | null;
    quality: number | null;
    verdict: string;
    summary: string;
    evidence: string;
    items: string;
  };
}

function jsonArray(text: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isVerdict(value: string): value is MemberVerdict {
  return (MEMBER_VERDICTS as readonly string[]).includes(value);
}

function evidenceOf(text: string): RecommendationEvidence[] {
  return jsonArray(text).flatMap((entry) => {
    const read = RecommendationEvidenceSchema.safeParse(entry);
    return read.success ? [read.data] : [];
  });
}

function itemsOf(text: string): MemberAssessmentRow['items'] {
  return jsonArray(text).flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') {
      return [];
    }
    const { id, title } = entry as { id?: unknown; title?: unknown };
    return typeof id === 'string'
      ? [{ id, title: typeof title === 'string' ? title : '' }]
      : [];
  });
}

/**
 * The ledger of a team's member assessments (see the entity). A card's
 * assessments are filed once: the live copy and the boot sweep may both reach
 * one card, and the second write changes nothing.
 */
@Injectable()
export class MemberAssessmentDao extends BaseDao<MemberAssessmentRecord> {
  constructor(em: EntityManager) {
    super(em, MemberAssessmentRecord);
  }

  async file(
    rows: readonly MemberAssessmentRow[],
    txEm?: EntityManager,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const now = Date.now();
    await (txEm ?? this.em.fork())
      .getKysely<AssessmentDatabase>({ convertValues: false })
      .insertInto('member_assessments')
      .values(
        rows.map((row) => ({
          id: randomUUID(),
          created_at: now,
          updated_at: now,
          deleted_at: null,
          slug: row.slug,
          chat_run_id: row.chatRunId,
          chat_kind: row.chatKind,
          card_seq: row.cardSeq,
          filed_at: row.filedAt.getTime(),
          library_version: row.libraryVersion,
          runs: row.runs,
          run_ids: JSON.stringify(row.runIds),
          member_id: row.memberId,
          usefulness: row.usefulness,
          quality: row.quality,
          verdict: row.verdict,
          summary: row.summary,
          evidence: JSON.stringify(row.evidence),
          items: JSON.stringify(row.items),
        })),
      )
      .onConflict((conflict) =>
        conflict.columns(['chat_run_id', 'card_seq', 'member_id']).doNothing(),
      )
      .execute();
  }

  /** Every assessment of one team's members, oldest card first. */
  async rowsOf(
    slug: string,
    txEm?: EntityManager,
  ): Promise<MemberAssessmentRow[]> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<AssessmentDatabase>({ convertValues: false })
      .selectFrom('member_assessments')
      .selectAll()
      .where('slug', '=', slug)
      .where('deleted_at', 'is', null)
      .orderBy('filed_at', 'asc')
      .orderBy('chat_run_id', 'asc')
      .orderBy('card_seq', 'asc')
      .orderBy('member_id', 'asc')
      .execute();
    return rows.flatMap((row): MemberAssessmentRow[] =>
      isVerdict(row.verdict)
        ? [
            {
              slug: row.slug,
              chatRunId: row.chat_run_id,
              chatKind: row.chat_kind,
              cardSeq: row.card_seq,
              filedAt: new Date(Number(row.filed_at)),
              libraryVersion: row.library_version,
              runs: row.runs,
              runIds:
                row.run_ids === null
                  ? []
                  : jsonArray(row.run_ids).filter(
                      (id): id is string => typeof id === 'string',
                    ),
              memberId: row.member_id,
              usefulness: row.usefulness,
              quality: row.quality,
              verdict: row.verdict,
              summary: row.summary,
              evidence: evidenceOf(row.evidence),
              items: itemsOf(row.items),
            },
          ]
        : [],
    );
  }
}
