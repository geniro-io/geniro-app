import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import type { MemoryService } from '../../memory/services/memory.service';
import type { Item } from '../../runs/entity/item.entity';
import type { ItemWire, RecommendationsPayload } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { AnalysisReportsService, checkItems } from './analysis-reports.service';
import type { ThreadTimelineService } from './thread-timeline.service';

const CARD: RecommendationsPayload = {
  sourceRunId: 'source',
  sourceKind: 'workflow',
  timing: null,
  items: [
    {
      id: 'W-1',
      target: 'workflow',
      territory: 'process',
      kind: 'parallelize',
      location: 'reviewer',
      title: 'Parallel reviewers',
      change: 'edges: …',
      evidence: [{ seq: 4, quote: 'waiting' }],
      rootCause: 'serial',
      impact: { minutesSaved: 12, basis: 'critical path', confidence: 4 },
      risk: { level: 'low', note: 'none' },
    },
  ],
};

function sink(cardAt: number | null) {
  const written: { kind: string; payload: object }[] = [];
  const service = new AnalysisReportsService(
    { fork: () => ({}) } as unknown as EntityManager,
    {} as RunDao,
    {
      rowAtSeq: (_runId: string, seq: number) =>
        Promise.resolve(
          seq === cardAt
            ? ({
                kind: 'recommendations',
                payload: JSON.stringify(CARD),
              } as Item)
            : null,
        ),
    } as unknown as ItemDao,
    {} as ThreadTimelineService,
    { enabled: true } as MemoryService,
  );
  return {
    written,
    mark: service.sinkFor(
      {
        analysisRunId: 'analysis',
        sourceRunId: 'source',
        snapshotSeq: 9,
        sourceWorking: false,
      },
      (kind, payload) => {
        written.push({ kind, payload });
        return Promise.resolve({ seq: 20 } as ItemWire);
      },
    ).mark,
  };
}

describe('AnalysisReportsService — outcomes', () => {
  it('writes one outcome row against the card it names', async () => {
    const { mark, written } = sink(7);
    const marks = {
      cardSeq: 7,
      outcomes: [
        { id: 'W-1', status: 'applied' as const, backup: '.backups/x.yaml' },
      ],
    };

    expect(await mark(marks)).toEqual({
      status: 'recorded',
      seq: 20,
      count: 1,
    });
    expect(written).toEqual([
      { kind: 'recommendation_outcome', payload: marks },
    ]);
  });

  it('refuses an id the card does not hold, and a seq that is not a card', async () => {
    const { mark, written } = sink(7);

    expect(
      await mark({ cardSeq: 7, outcomes: [{ id: 'R-4', status: 'failed' }] }),
    ).toEqual({ status: 'refused', reason: 'the card has no R-4' });
    expect(
      await mark({ cardSeq: 8, outcomes: [{ id: 'W-1', status: 'applied' }] }),
    ).toMatchObject({ status: 'refused' });
    expect(written).toEqual([]);
  });
});

describe('checkItems', () => {
  const memoryItem = {
    ...CARD.items[0]!,
    id: 'M-1',
    target: 'memory' as const,
    kind: 'forget',
    location: 'm12',
  };

  it('caps memory items per target like any other', () => {
    const six = ['M-1', 'M-2', 'M-3', 'M-4', 'M-5', 'M-6'].map((id) => ({
      ...memoryItem,
      id,
    }));

    expect(checkItems({ items: six }, 'chat', true)).toContain(
      '6 memory items',
    );
  });
});
