import type { EntityManager } from '@mikro-orm/sqlite';
import { ConflictException, NotFoundException } from '@packages/common';

import {
  type RecommendationApply,
  RecommendationApplySchema,
  type RecommendationsPayload,
  RecommendationsPayloadSchema,
} from '../chat.types';
import type { ItemDao } from '../dao/item.dao';

function fromLegacyTarget(item: unknown): unknown {
  return item !== null &&
    typeof item === 'object' &&
    (item as { target?: unknown }).target === 'workflow'
    ? { ...item, target: 'team' }
    : item;
}

/**
 * A `recommendations` payload read against today's schema. A card filed before
 * the rename names its source and its team items' target `workflow` and
 * carries its figures as `workflowStats`.
 */
export function parseRecommendationsPayload(
  raw: unknown,
): ReturnType<typeof RecommendationsPayloadSchema.safeParse> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return RecommendationsPayloadSchema.safeParse(raw);
  }
  const { workflowStats, ...card } = raw as Record<string, unknown>;
  return RecommendationsPayloadSchema.safeParse({
    ...card,
    ...(card.teamStats === undefined && workflowStats !== undefined
      ? { teamStats: workflowStats }
      : {}),
    sourceKind: card.sourceKind === 'workflow' ? 'team' : card.sourceKind,
    items: Array.isArray(card.items)
      ? card.items.map(fromLegacyTarget)
      : card.items,
  });
}

/** The `recommendations` card at `seq` in `runId`, or a refusal. */
export async function readCard(
  itemDao: ItemDao,
  runId: string,
  seq: number,
  em?: EntityManager,
): Promise<RecommendationsPayload> {
  const row = await itemDao.rowAtSeq(runId, seq, em);
  if (row === null || row.kind !== 'recommendations') {
    throw new NotFoundException(
      'RECOMMENDATIONS_NOT_FOUND',
      `no recommendations card at seq ${seq}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    parsed = null;
  }
  const card = parseRecommendationsPayload(parsed);
  if (!card.success) {
    throw new ConflictException(
      'RECOMMENDATIONS_UNREADABLE',
      `the card at seq ${seq} cannot be read`,
    );
  }
  return card.data;
}

/** The Apply a user message's payload carries, or null. */
export function applyOf(payload: string): RecommendationApply | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const apply = RecommendationApplySchema.safeParse(
    (parsed as { apply?: unknown } | null)?.apply,
  );
  return apply.success ? apply.data : null;
}

/** Every Apply sent in a run, oldest first. */
export async function appliesOf(
  itemDao: ItemDao,
  runId: string,
  em?: EntityManager,
): Promise<RecommendationApply[]> {
  const rows = await itemDao.userMessagesInOrder(runId, em);
  return rows
    .map((row) => applyOf(row.payload))
    .filter((apply): apply is RecommendationApply => apply !== null);
}
