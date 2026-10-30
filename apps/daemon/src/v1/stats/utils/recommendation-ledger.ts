import {
  type RecommendationApply,
  RecommendationApplySchema,
  type RecommendationMarks,
  RecommendationMarksSchema,
  RecommendationsPayloadSchema,
} from '../../agents/chat.types';
import type { Run } from '../../runs/entity/run.entity';
import type {
  FiledRecommendation,
  WorkflowRecommendationSource,
} from '../stats.types';

/** The workflow a chat files recommendations about, or null for a chat that files none. */
export function recommendationSourceOf(
  run: Pick<Run, 'id' | 'analysisWorkflowSlug' | 'editsWorkflowSlug'>,
): WorkflowRecommendationSource | null {
  if (run.analysisWorkflowSlug !== null) {
    return {
      chatRunId: run.id,
      slug: run.analysisWorkflowSlug,
      chatKind: 'analysis',
    };
  }
  if (run.editsWorkflowSlug !== null) {
    return {
      chatRunId: run.id,
      slug: run.editsWorkflowSlug,
      chatKind: 'builder',
    };
  }
  return null;
}

/** A `recommendations` row's items as the ledger files them, or null when the row does not read as a card. */
export function filedRecommendationsOf(
  source: WorkflowRecommendationSource,
  row: { seq: number; createdAt: Date; payload: unknown },
  libraryVersion: string | null,
): FiledRecommendation[] | null {
  const card = RecommendationsPayloadSchema.safeParse(row.payload);
  if (!card.success) {
    return null;
  }
  return card.data.items.map((item) => ({
    slug: source.slug,
    chatRunId: source.chatRunId,
    chatKind: source.chatKind,
    cardSeq: row.seq,
    filedAt: row.createdAt,
    libraryVersion,
    itemId: item.id,
    target: item.target,
    territory: item.territory,
    kind: item.kind,
    location: item.location,
    title: item.title,
    change: item.change,
    rootCause: item.rootCause,
    minutesSaved: item.impact.minutesSaved,
    costSavedUsd: item.impact.costSavedUsd ?? null,
    expectedOutcome: item.impact.outcome ?? null,
    confidence: item.impact.confidence,
    risk: item.risk.level,
  }));
}

/** The Apply a user message's payload carries, or null. */
export function applyIn(payload: unknown): RecommendationApply | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const apply = RecommendationApplySchema.safeParse(
    (payload as { apply?: unknown }).apply,
  );
  return apply.success ? apply.data : null;
}

/** The marks a `recommendation_outcome` row records, or null. */
export function marksIn(payload: unknown): RecommendationMarks | null {
  const marks = RecommendationMarksSchema.safeParse(payload);
  return marks.success ? marks.data : null;
}
