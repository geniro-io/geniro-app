import type { EntityManager } from '@mikro-orm/sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  KnowledgeActor,
  KnowledgeItemOutcome,
} from '../../knowledge/knowledge.types';
import type { KnowledgeService } from '../../knowledge/services/knowledge.service';
import type { AnalysisTurn, RecommendationItem } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import { moveOrderRefusal } from '../utils/recommendations-card';
import { KnowledgeItemsService } from './knowledge-items.service';

const TURN = { analysisRunId: 'analysis' } as AnalysisTurn;
const ACTOR: KnowledgeActor = {
  kind: 'analysis',
  runId: 'analysis',
  memberId: 'agent',
  agentKind: 'claude',
  model: 'haiku',
};
const CARD_SEQ = 4;

function item(over: Partial<RecommendationItem>): RecommendationItem {
  return {
    id: 'R-1',
    target: 'repo',
    territory: 'domain',
    kind: 'remove',
    location: 'AGENTS.md:12',
    title: 'Take the guide out of AGENTS.md',
    change: 'one line naming the document',
    evidence: [{ seq: 1, quote: 'q' }],
    rootCause: 'it is paid for on every turn',
    impact: {
      minutesSaved: 1,
      costSavedUsd: null,
      basis: 'the instruction sizes',
      confidence: 3,
      outcome: 'less to read',
    },
    risk: { level: 'low', note: 'none' },
    ...over,
  } as RecommendationItem;
}

const ADD = item({
  id: 'K-1',
  target: 'knowledge',
  kind: 'add',
  location: 'new',
  title: 'Keep the guide as a document',
  change: 'The whole guide.',
  document: { place: 'global', title: 'Guide', whenToRead: 'Starting.' },
  movesWith: 'R-1',
});
const RETIRE = item({
  id: 'K-2',
  target: 'knowledge',
  kind: 'retire',
  location: 'guide',
  title: 'The rule moves into the instructions',
  change: 'Nothing reads it in time.',
  document: { place: 'global', handle: 'guide', rev: 3 },
  movesWith: 'P-1',
});
const PROJECT = item({ id: 'P-1', target: 'project', location: 'p1' });

const dao = (options: {
  items: RecommendationItem[];
  ids?: string[];
  applies?: boolean;
  marks?: { id: string; status: string }[][];
}): ItemDao =>
  ({
    userMessagesInOrder: async () =>
      options.applies === false
        ? []
        : [
            {
              payload: JSON.stringify({
                text: 'Apply',
                apply: {
                  cardSeq: CARD_SEQ,
                  ids: options.ids ?? options.items.map((entry) => entry.id),
                },
              }),
            },
          ],
    rowAtSeq: async () => ({
      kind: 'recommendations',
      payload: JSON.stringify({
        sourceRunId: 'source',
        sourceKind: 'chat',
        timing: null,
        items: options.items,
      }),
    }),
    recommendationOutcomeRows: async () =>
      (options.marks ?? []).map((outcomes, seq) => ({
        seq,
        payload: JSON.stringify({ cardSeq: CARD_SEQ, outcomes }),
      })),
  }) as unknown as ItemDao;

describe('KnowledgeItemsService', () => {
  const written: KnowledgeItemOutcome = {
    kind: 'archived',
    document: { handle: 'guide' },
  } as KnowledgeItemOutcome;
  let applyRecommended: ReturnType<typeof vi.fn>;

  const carryOut = (itemDao: ItemDao, id: string) =>
    new KnowledgeItemsService(
      { fork: () => ({}) } as unknown as EntityManager,
      itemDao,
      { applyRecommended } as unknown as KnowledgeService,
    ).carryOut(TURN, ACTOR, id);

  beforeEach(() => {
    applyRecommended = vi.fn(async () => written);
  });

  it('writes the text on the card as the filing agent', async () => {
    await expect(
      carryOut(dao({ items: [item({}), ADD] }), 'K-1'),
    ).resolves.toBe(written);

    expect(applyRecommended).toHaveBeenCalledWith(ACTOR, {
      kind: 'add',
      place: 'global',
      title: 'Guide',
      whenToRead: 'Starting.',
      body: 'The whole guide.',
      reason: 'Keep the guide as a document',
    });
  });

  it.each([
    ['nothing was applied', { items: [ADD], applies: false }, 'NOT_APPLIED'],
    ['it was not selected', { items: [ADD], ids: ['R-1'] }, 'NOT_SELECTED'],
  ])('refuses when %s, writing nothing', async (_name, options, code) => {
    await expect(carryOut(dao(options), 'K-1')).resolves.toMatchObject({
      kind: 'item-refused',
      code,
    });
    expect(applyRecommended).not.toHaveBeenCalled();
  });

  it('refuses another target’s id and a card that cannot be read', async () => {
    await expect(
      carryOut(dao({ items: [item({}), ADD] }), 'R-1'),
    ).resolves.toMatchObject({ code: 'NOT_A_KNOWLEDGE_ITEM' });
    const unreadable = {
      ...dao({ items: [ADD] }),
      rowAtSeq: async () => null,
    } as unknown as ItemDao;
    await expect(carryOut(unreadable, 'K-1')).resolves.toMatchObject({
      code: 'CARD_GONE',
    });
    expect(applyRecommended).not.toHaveBeenCalled();
  });

  it('retires a document only once the text it moves to is marked applied', async () => {
    const items = [PROJECT, RETIRE];

    await expect(carryOut(dao({ items }), 'K-2')).resolves.toMatchObject({
      code: 'MOVE_SOURCE_FIRST',
    });
    await expect(
      carryOut(
        dao({ items, marks: [[{ id: 'P-1', status: 'failed' }]] }),
        'K-2',
      ),
    ).resolves.toMatchObject({ code: 'MOVE_SOURCE_FIRST' });
    expect(applyRecommended).not.toHaveBeenCalled();

    await expect(
      carryOut(
        dao({ items, marks: [[{ id: 'P-1', status: 'applied' }]] }),
        'K-2',
      ),
    ).resolves.toBe(written);
    expect(applyRecommended).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ kind: 'retire', handle: 'guide', rev: 3 }),
    );
  });
});

describe('moveOrderRefusal', () => {
  const apply = { cardSeq: CARD_SEQ, ids: ['K-1', 'R-1'] };

  it('holds a source item back until its document is marked applied', async () => {
    const items = [item({}), ADD];

    await expect(
      moveOrderRefusal(dao({ items }), 'analysis', apply, ['R-1']),
    ).resolves.toMatchObject({ error: 'MOVE_DOCUMENT_FIRST' });
    await expect(
      moveOrderRefusal(
        dao({
          items,
          marks: [
            [{ id: 'K-1', status: 'applied' }],
            [{ id: 'K-1', status: 'failed' }],
          ],
        }),
        'analysis',
        apply,
        ['R-1'],
      ),
    ).resolves.toMatchObject({ error: 'MOVE_DOCUMENT_FIRST' });
    await expect(
      moveOrderRefusal(
        dao({ items, marks: [[{ id: 'K-1', status: 'applied' }]] }),
        'analysis',
        apply,
        ['R-1'],
      ),
    ).resolves.toBeNull();
  });

  it('leaves alone an item no document moves with, and the source of a retire', async () => {
    await expect(
      moveOrderRefusal(dao({ items: [PROJECT, RETIRE] }), 'analysis', apply, [
        'P-1',
      ]),
    ).resolves.toBeNull();
    await expect(
      moveOrderRefusal(dao({ items: [item({}), ADD] }), 'analysis', apply, [
        'P-9',
      ]),
    ).resolves.toBeNull();
  });

  it('names no move on a card it cannot read, leaving that to the write', async () => {
    await expect(
      moveOrderRefusal(
        { rowAtSeq: async () => null } as unknown as ItemDao,
        'analysis',
        apply,
        ['R-1'],
      ),
    ).resolves.toBeNull();
  });
});
