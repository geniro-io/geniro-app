import {
  type RecommendationApply,
  RecommendationApplySchema,
  type RecommendationMarks,
  RecommendationMarksSchema,
} from '../../agents/chat.types';
import { parseRecommendationsPayload } from '../../agents/utils/recommendations-card';
import type { Run } from '../../runs/entity/run.entity';
import type {
  FiledRecommendation,
  MemberAssessmentRow,
  MemberAssessmentSource,
  TeamRecommendationSource,
} from '../stats.types';

/** The team a chat files recommendations about, or null for a chat that files none. */
export function recommendationSourceOf(
  run: Pick<Run, 'id' | 'analysisTeamSlug' | 'editsTeamSlug'>,
): TeamRecommendationSource | null {
  if (run.analysisTeamSlug !== null) {
    return {
      chatRunId: run.id,
      slug: run.analysisTeamSlug,
      chatKind: 'analysis',
    };
  }
  if (run.editsTeamSlug !== null) {
    return {
      chatRunId: run.id,
      slug: run.editsTeamSlug,
      chatKind: 'builder',
    };
  }
  return null;
}

/**
 * The team a chat's member assessments are about: the team of a chat that
 * files its recommendations, or for a thread analysis the team its source run
 * ran — given here as `analysedRun`, null for none or a plain chat.
 */
export function assessmentSourceOf(
  run: Pick<
    Run,
    'id' | 'analysisTeamSlug' | 'editsTeamSlug' | 'agentKind' | 'model'
  >,
  analysedRun: Pick<Run, 'teamId'> | null,
): MemberAssessmentSource | null {
  const judge = { agent: run.agentKind ?? null, model: run.model ?? null };
  const own = recommendationSourceOf(run);
  if (own !== null) {
    return { ...own, judge };
  }
  return analysedRun?.teamId
    ? {
        chatRunId: run.id,
        slug: analysedRun.teamId,
        chatKind: 'thread',
        judge,
      }
    : null;
}

/** A `recommendations` row's member assessments as the ledger files them, or null when the row does not read as a card. */
export function filedAssessmentsOf(
  source: MemberAssessmentSource,
  row: { seq: number; createdAt: Date; payload: unknown },
  libraryVersion: string | null,
): MemberAssessmentRow[] | null {
  const card = parseRecommendationsPayload(row.payload);
  if (!card.success) {
    return null;
  }
  const titles = new Map(card.data.items.map((item) => [item.id, item.title]));
  const runIds =
    source.chatKind === 'thread' || !card.data.teamStats
      ? [card.data.sourceRunId]
      : card.data.teamStats.runList.map((run) => run.runId);
  const runs =
    source.chatKind === 'thread' ? 1 : (card.data.teamStats?.runs ?? 1);
  return (card.data.members ?? []).map((member) => ({
    slug: source.slug,
    chatRunId: source.chatRunId,
    chatKind: source.chatKind,
    cardSeq: row.seq,
    filedAt: row.createdAt,
    libraryVersion,
    runs,
    runIds,
    memberId: member.member,
    usefulness: member.usefulness,
    quality: member.quality,
    verdict: member.verdict,
    summary: member.summary,
    evidence: member.evidence,
    items: member.items.map((id) => ({ id, title: titles.get(id) ?? '' })),
    judge: source.judge,
    userVerdict: null,
  }));
}

/** A `recommendations` row's items as the ledger files them, or null when the row does not read as a card. */
export function filedRecommendationsOf(
  source: TeamRecommendationSource,
  row: { seq: number; createdAt: Date; payload: unknown },
  libraryVersion: string | null,
): FiledRecommendation[] | null {
  const card = parseRecommendationsPayload(row.payload);
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
