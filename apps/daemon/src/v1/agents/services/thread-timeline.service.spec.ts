import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { RunWaterfallFold } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { ChatWaterfallService } from './chat-waterfall.service';
import type { ItemCallIndexService } from './item-call-index.service';
import { ThreadTimelineService } from './thread-timeline.service';

const FOLD = {
  from: '2026-10-14T10:00:00.000Z',
  to: '2026-10-14T10:01:00.000Z',
  working: false,
  lanes: [],
  turns: [],
  calls: [],
  waits: [],
  delegates: [],
  totals: {},
  waitedOnUserMs: null,
} as unknown as RunWaterfallFold;

function build() {
  const fold = vi.fn(() => Promise.resolve(FOLD));
  const ensureIndexed = vi.fn(() => Promise.resolve());
  const toolCallTimes = vi.fn(() => Promise.resolve([]));
  const service = new ThreadTimelineService(
    { fork: () => ({}) } as unknown as EntityManager,
    { fold } as unknown as ChatWaterfallService,
    { toolCallTimes } as unknown as ItemDao,
    { ensureIndexed } as unknown as ItemCallIndexService,
  );
  return { service, fold, ensureIndexed, toolCallTimes };
}

describe('ThreadTimelineService', () => {
  it('folds a snapshot once, and again for another snapshot or flag', async () => {
    const { service, fold } = build();

    await service.read('source', 9, false);
    await service.read('source', 9, false);
    expect(fold).toHaveBeenCalledTimes(1);

    await service.read('source', 9, true);
    await service.read('source', 10, false);
    expect(fold).toHaveBeenCalledTimes(3);
    expect(fold).toHaveBeenLastCalledWith(
      'source',
      10,
      expect.anything(),
      false,
    );
  });

  it("stamps the run's call membership before pairing its tool calls", async () => {
    const { service, ensureIndexed, toolCallTimes } = build();

    await service.read('source', 9, false);

    expect(ensureIndexed).toHaveBeenCalledWith('source');
    expect(ensureIndexed.mock.invocationCallOrder[0]!).toBeLessThan(
      toolCallTimes.mock.invocationCallOrder[0]!,
    );
  });
});
