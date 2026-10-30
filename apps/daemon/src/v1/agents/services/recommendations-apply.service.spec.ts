import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import type {
  ItemWire,
  RecommendationItem,
  RecommendationsPayload,
} from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import type { ChatService } from './chat.service';
import { RecommendationsApplyService } from './recommendations-apply.service';

function item(id: string, title: string): RecommendationItem {
  return {
    id,
    target: id.startsWith('W')
      ? 'workflow'
      : id.startsWith('M')
        ? 'memory'
        : 'repo',
    territory: id.startsWith('W') ? 'process' : 'domain',
    kind: id.startsWith('W')
      ? 'parallelize'
      : id.startsWith('M')
        ? 'update'
        : 'ADD',
    location: id.startsWith('W')
      ? 'reviewer'
      : id.startsWith('M')
        ? 'm12'
        : 'AGENTS.md:12',
    title,
    change: `the exact change for ${id}`,
    evidence: [{ seq: 4, quote: 'waited' }],
    rootCause: 'serial calls',
    impact: {
      minutesSaved: 12,
      costSavedUsd: null,
      basis: 'critical path',
      confidence: 4,
      outcome: 'reviewer waits end',
    },
    risk: { level: 'low', note: 'none' },
  };
}

const CARD: RecommendationsPayload = {
  sourceRunId: 'source',
  sourceKind: 'workflow',
  timing: null,
  items: [item('W-1', 'Run reviewers in parallel'), item('R-1', 'Add a rule')],
};

function build(
  options: {
    analysis?: boolean;
    workflowAnalysis?: boolean;
    builder?: boolean;
    card?: Partial<Item> | null;
    appliedCards?: number[];
  } = {},
) {
  const sendMessage = vi.fn(() => Promise.resolve({ seq: 9 } as ItemWire));
  const service = new RecommendationsApplyService(
    { fork: () => ({}) } as unknown as EntityManager,
    {
      getById: () =>
        Promise.resolve({
          id: 'analysis',
          analysisSourceRunId:
            options.analysis === false || options.workflowAnalysis
              ? null
              : 'source',
          analysisWorkflowSlug: options.workflowAnalysis ? 'team' : null,
          editsWorkflowSlug: options.builder ? 'team' : null,
        } as Run),
    } as unknown as RunDao,
    {
      rowAtSeq: () =>
        Promise.resolve(
          options.card === null
            ? null
            : ({
                kind: 'recommendations',
                payload: JSON.stringify(CARD),
                ...options.card,
              } as Item),
        ),
      userMessagesInOrder: () =>
        Promise.resolve(
          (options.appliedCards ?? []).map((cardSeq, index) => ({
            seq: index,
            payload: JSON.stringify({
              text: 'apply',
              apply: { cardSeq, ids: ['W-1'] },
            }),
          })),
        ),
    } as unknown as ItemDao,
    { sendMessage } as unknown as ChatService,
  );
  return { service, sendMessage };
}

describe('RecommendationsApplyService.apply', () => {
  it('sends the selected items in full and persists the selection with the press id', async () => {
    const { service, sendMessage } = build();

    await service.apply('analysis', {
      cardSeq: 5,
      ids: ['W-1'],
      note: 'careful with the reviewer',
      clientMessageId: 'press-1',
    });

    const [runId, text, images, options] = sendMessage.mock
      .calls[0] as unknown as [
      string,
      string,
      unknown[],
      Record<string, unknown>,
    ];
    expect(runId).toBe('analysis');
    expect(images).toEqual([]);
    expect(text).toContain('### W-1 · Run reviewers in parallel');
    expect(text).toContain(
      'Target: workflow · process · parallelize · reviewer',
    );
    expect(text).toContain('the exact change for W-1');
    expect(text).not.toContain('the exact change for R-1');
    expect(text).toContain('Not selected — leave alone: R-1.');
    expect(text).toContain('Note from the user: careful with the reviewer');
    expect(text).toContain('mark_recommendations with cardSeq 5');
    expect(options).toEqual({
      clientMessageId: 'press-1',
      apply: { cardSeq: 5, ids: ['W-1'] },
    });
  });

  it('sends a memory item with its handle and kind, and keeps it on the card', async () => {
    const { service, sendMessage } = build({
      card: {
        payload: JSON.stringify({
          ...CARD,
          items: [...CARD.items, item('M-1', 'Correct a stale note')],
        }),
      },
    });

    await service.apply('analysis', {
      cardSeq: 5,
      ids: ['M-1'],
      clientMessageId: 'press-4',
    });

    const text = (sendMessage.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toContain('### M-1 · Correct a stale note');
    expect(text).toContain('Target: memory · domain · update · m12');
    expect(text).toContain('the exact change for M-1');
    expect(text).toContain('Not selected — leave alone: W-1, R-1.');
  });

  it('refuses a card whose items name no territory, and sends nothing', async () => {
    const untagged = CARD.items.map(({ territory: _omitted, ...rest }) => rest);
    const { service, sendMessage } = build({
      card: { payload: JSON.stringify({ ...CARD, items: untagged }) },
    });

    await expect(
      service.apply('analysis', {
        cardSeq: 5,
        ids: ['W-1'],
        clientMessageId: 'press-3',
      }),
    ).rejects.toMatchObject({ errorCode: 'RECOMMENDATIONS_UNREADABLE' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a second Apply of the same card, and sends nothing', async () => {
    const { service, sendMessage } = build({ appliedCards: [5] });

    await expect(
      service.apply('analysis', {
        cardSeq: 5,
        ids: ['R-1'],
        clientMessageId: 'press-2',
      }),
    ).rejects.toMatchObject({ errorCode: 'ALREADY_APPLIED' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lets a different card be applied after another one was', async () => {
    const { service, sendMessage } = build({ appliedCards: [3] });

    await service.apply('analysis', {
      cardSeq: 5,
      ids: ['W-1'],
      clientMessageId: 'press-3',
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses an id the card does not hold', async () => {
    await expect(
      build().service.apply('analysis', {
        cardSeq: 5,
        ids: ['W-9'],
        clientMessageId: 'press-1',
      }),
    ).rejects.toMatchObject({ errorCode: 'UNKNOWN_RECOMMENDATION' });
  });

  it('refuses a seq that is not a recommendations card, and a chat that is not an analysis', async () => {
    await expect(
      build({ card: { kind: 'message' } }).service.apply('analysis', {
        cardSeq: 5,
        ids: ['W-1'],
        clientMessageId: 'press-1',
      }),
    ).rejects.toMatchObject({ errorCode: 'RECOMMENDATIONS_NOT_FOUND' });
    await expect(
      build({ analysis: false }).service.apply('analysis', {
        cardSeq: 5,
        ids: ['W-1'],
        clientMessageId: 'press-1',
      }),
    ).rejects.toMatchObject({ errorCode: 'NOT_AN_ANALYSIS' });
  });

  it("applies a workflow analysis's card like a thread analysis's", async () => {
    await expect(
      build({ workflowAnalysis: true }).service.apply('analysis', {
        cardSeq: 5,
        ids: ['W-1'],
        clientMessageId: 'press-1',
      }),
    ).resolves.toEqual({ seq: 9 });
  });

  it("applies the card a workflow's builder chat posted", async () => {
    const { service, sendMessage } = build({ analysis: false, builder: true });

    await expect(
      service.apply('analysis', {
        cardSeq: 5,
        ids: ['W-1'],
        clientMessageId: 'press-1',
      }),
    ).resolves.toEqual({ seq: 9 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
