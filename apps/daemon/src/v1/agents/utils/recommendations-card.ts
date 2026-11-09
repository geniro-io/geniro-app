import type { EntityManager } from '@mikro-orm/sqlite';
import { ConflictException, NotFoundException } from '@packages/common';

import type { KnowledgeItemWrite } from '../../knowledge/knowledge.types';
import {
  type CardRecommendationItem,
  KNOWLEDGE_ITEM_KINDS,
  RECOMMENDATION_ID_PREFIX,
  type RecommendationApply,
  RecommendationApplySchema,
  RecommendationMarksSchema,
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

const WRITTEN_ITEMS = {
  team: {
    code: 'NOT_A_TEAM_ITEM',
    one: 'is not a team item',
    many: 'are not team items',
    only: 'only W- items change the team',
  },
  overlay: {
    code: 'NOT_AN_OVERLAY_ITEM',
    one: 'is not an overlay item',
    many: 'are not overlay items',
    only: "only O- items change a project's overlay",
  },
  project: {
    code: 'NOT_A_PROJECT_ITEM',
    one: 'is not a project item',
    many: 'are not project items',
    only: 'only P- items change project instructions',
  },
  knowledge: {
    code: 'NOT_A_KNOWLEDGE_ITEM',
    one: 'is not a knowledge item',
    many: 'are not knowledge items',
    only: 'only K- items change knowledge',
  },
} as const;

/**
 * Why an analysis's write may not carry out `ids`: an id of another target,
 * none at all, or one the user did not select in the newest Apply. Null when
 * every id is the target's and selected there.
 */
export function unappliedRefusal(
  target: keyof typeof WRITTEN_ITEMS,
  ids: readonly string[],
  apply: RecommendationApply,
): { error: string; message: string } | null {
  const words = WRITTEN_ITEMS[target];
  const others = ids.filter(
    (id) => !id.startsWith(RECOMMENDATION_ID_PREFIX[target]),
  );
  if (others.length > 0) {
    return {
      error: words.code,
      message: `${others.join(', ')} ${others.length === 1 ? words.one : words.many} — ${words.only}`,
    };
  }
  const unselected = ids.filter((id) => !apply.ids.includes(id));
  if (ids.length === 0 || unselected.length > 0) {
    return {
      error: 'NOT_SELECTED',
      message:
        ids.length === 0
          ? 'name the recommendation ids this change carries out'
          : `${unselected.join(', ')} ${unselected.length === 1 ? 'was' : 'were'} not selected in the latest Apply (${apply.ids.join(', ')})`,
    };
  }
  return null;
}

/** A knowledge item as the store writes it, or null for any other item. */
export function knowledgeWriteOf(
  item: CardRecommendationItem,
): KnowledgeItemWrite | null {
  const kind = KNOWLEDGE_ITEM_KINDS.find((entry) => entry === item.kind);
  if (
    item.target !== 'knowledge' ||
    item.document === undefined ||
    kind === undefined
  ) {
    return null;
  }
  return { ...item.document, kind, body: item.change, reason: item.title };
}

/** The ids of the card at `cardSeq` whose newest mark says applied. */
export async function appliedMarksOf(
  itemDao: ItemDao,
  runId: string,
  cardSeq: number,
  em?: EntityManager,
): Promise<Set<string>> {
  const marks = await newestMarksOf(itemDao, runId, cardSeq, em);
  return new Set(
    [...marks].flatMap(([id, status]) => (status === 'applied' ? [id] : [])),
  );
}

/** Each marked id of the card at `cardSeq` with its newest status. */
async function newestMarksOf(
  itemDao: ItemDao,
  runId: string,
  cardSeq: number,
  em?: EntityManager,
): Promise<Map<string, string>> {
  const newest = new Map<string, string>();
  for (const row of await itemDao.recommendationOutcomeRows(runId, em)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      parsed = null;
    }
    const marks = RecommendationMarksSchema.safeParse(parsed);
    if (!marks.success || marks.data.cardSeq !== cardSeq) {
      continue;
    }
    for (const outcome of marks.data.outcomes) {
      newest.set(outcome.id, outcome.status);
    }
  }
  return newest;
}

/** Whether every item an Apply took from the card at `cardSeq` has a mark. */
export async function everySelectedMarked(
  itemDao: ItemDao,
  runId: string,
  cardSeq: number,
  em?: EntityManager,
): Promise<boolean> {
  const apply = (await appliesOf(itemDao, runId, em))
    .filter((entry) => entry.cardSeq === cardSeq)
    .at(-1);
  if (apply === undefined) {
    return false;
  }
  const marks = await newestMarksOf(itemDao, runId, cardSeq, em);
  return apply.ids.every((id) => marks.has(id));
}

/**
 * Why `ids` may not be written yet: text leaves its source only once the
 * document it moves to is written, so it is never in neither place. A retire
 * goes the other way round (`KnowledgeItemsService`).
 */
export async function moveOrderRefusal(
  itemDao: ItemDao,
  runId: string,
  apply: RecommendationApply,
  ids: readonly string[],
  em?: EntityManager,
): Promise<{ error: string; message: string } | null> {
  let card: RecommendationsPayload;
  try {
    card = await readCard(itemDao, runId, apply.cardSeq, em);
  } catch {
    // The write has its own answer to a card it cannot read; this one names no move.
    return null;
  }
  const documents = card.items.filter(
    (item) =>
      item.movesWith !== undefined &&
      ids.includes(item.movesWith) &&
      item.kind !== 'retire',
  );
  if (documents.length === 0) {
    return null;
  }
  const applied = await appliedMarksOf(itemDao, runId, apply.cardSeq, em);
  const waiting = documents.find((item) => !applied.has(item.id));
  return waiting === undefined
    ? null
    : {
        error: 'MOVE_DOCUMENT_FIRST',
        message: `${waiting.movesWith} moves text into ${waiting.id}: write that document with knowledge_save and mark it applied first, so the text is never in neither place`,
      };
}
