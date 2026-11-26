import { describe, expect, it } from 'vitest';

import type { ThreadAttention } from '../components/thread-labels';
import type { BlockOrders } from './block-orders';
import { blockIdOf } from './block-places';
import { FIXTURE_PROJECTS, graphThreadsOf } from './graph-fixtures';
import {
  type GraphThread,
  orderedBlocks,
  threadsByAttention,
  workingThreadsInGraphOrder,
} from './graph-order';
import { graphBlocks, MAX_THREAD_NODES } from './graph-view';
import type { CardBand } from './open-cards';

const A = FIXTURE_PROJECTS[0]!.id;
const B = FIXTURE_PROJECTS[1]!.id;
const view = graphThreadsOf(1)[0]!.view;

function thread(
  id: string,
  projectId: string | null,
  createdAt: string,
  attention: ThreadAttention = 'quiet',
): GraphThread {
  return {
    id,
    projectId,
    createdAt,
    view: {
      ...view,
      attention,
      status: attention === 'working' ? 'working' : 'idle',
    },
  };
}

function idsOf(threads: readonly GraphThread[]): string[] {
  return threads.map((entry) => entry.id);
}

describe('orderedBlocks', () => {
  it('stands the known projects in the order given, the unknown ones after them in first-seen order, and the threads of no project last', () => {
    const all = [
      thread('a', null, '2026-01-05T00:00:00Z'),
      thread('b', 'project-x', '2026-01-04T00:00:00Z'),
      thread('c', B, '2026-01-03T00:00:00Z'),
      thread('d', 'project-y', '2026-01-02T00:00:00Z'),
      thread('e', A, '2026-01-01T00:00:00Z'),
    ];
    const blocks = orderedBlocks(all, FIXTURE_PROJECTS, new Map(), all);
    expect(blocks.map((block) => block.id)).toEqual(
      [A, B, 'project-x', 'project-y', null].map((projectId) =>
        blockIdOf({ projectId }),
      ),
    );
  });

  it('leaves out a project none of whose threads is on the board', () => {
    const blocks = orderedBlocks(
      [thread('a', B, '2026-01-01T00:00:00Z')],
      FIXTURE_PROJECTS,
      new Map(),
    );
    expect(blocks.map((block) => block.id)).toEqual([
      blockIdOf({ projectId: B }),
    ]);
  });

  it('ranks the shown threads of a block by attention, working first', () => {
    const shown = [
      thread('quiet', A, '2026-01-03T00:00:00Z', 'quiet'),
      thread('asking', A, '2026-01-02T00:00:00Z', 'question'),
      thread('working', A, '2026-01-01T00:00:00Z', 'working'),
    ];
    const [block] = orderedBlocks(shown, FIXTURE_PROJECTS, new Map());
    expect(idsOf(block!.threads)).toEqual(['working', 'asking', 'quiet']);
  });

  it("takes an open card's band over its view's attention, as the card stood when it opened", () => {
    const shown = [
      thread('a', A, '2026-01-02T00:00:00Z', 'working'),
      thread('b', A, '2026-01-01T00:00:00Z', 'question'),
    ];
    const open = new Map<string, { band: CardBand }>([
      ['a', { band: { attention: 'quiet', lastAt: view.lastAt } }],
    ]);
    const [withoutCard] = orderedBlocks(shown, FIXTURE_PROJECTS, new Map());
    const [withCard] = orderedBlocks(shown, FIXTURE_PROJECTS, open);
    expect(idsOf(withoutCard!.threads)).toEqual(['a', 'b']);
    expect(idsOf(withCard!.threads)).toEqual(['b', 'a']);
  });

  it('stands a thread the user dropped in the order they set, and an unnamed one joins where the block order puts it', () => {
    const shown = [
      thread('a', A, '2026-01-03T00:00:00Z', 'working'),
      thread('b', A, '2026-01-02T00:00:00Z', 'working'),
      thread('c', A, '2026-01-01T00:00:00Z', 'working'),
    ];
    const orders: BlockOrders = { [blockIdOf({ projectId: A })]: ['c', 'a'] };
    const [block] = orderedBlocks(
      shown,
      FIXTURE_PROJECTS,
      new Map(),
      shown,
      orders,
    );
    expect(idsOf(block!.threads)).toEqual(['b', 'c', 'a']);
  });
});

describe('workingThreadsInGraphOrder', () => {
  it('keeps only the working threads, block by block in the order the blocks stand', () => {
    const threads = [
      thread('none', null, '2026-01-05T00:00:00Z', 'working'),
      thread('quiet', A, '2026-01-04T00:00:00Z', 'quiet'),
      thread('second', B, '2026-01-03T00:00:00Z', 'working'),
      thread('first', A, '2026-01-01T00:00:00Z', 'working'),
    ];
    expect(
      idsOf(
        workingThreadsInGraphOrder(threads, FIXTURE_PROJECTS, new Map(), {}),
      ),
    ).toEqual(['first', 'second', 'none']);
  });

  it('stands the newest started first inside a block, whatever order the threads come in', () => {
    const threads = [
      thread('old', A, '2026-01-01T00:00:00Z', 'working'),
      thread('new', A, '2026-01-03T00:00:00Z', 'working'),
    ];
    expect(
      idsOf(
        workingThreadsInGraphOrder(threads, FIXTURE_PROJECTS, new Map(), {}),
      ),
    ).toEqual(['new', 'old']);
  });

  it('gives a working thread past the node cap its face, in its place', () => {
    const asking = Array.from({ length: MAX_THREAD_NODES + 6 }, (_, index) =>
      thread(
        'asking-' + index,
        A,
        new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        'question',
      ),
    );
    const working = thread('working', A, '2025-12-01T00:00:00Z', 'working');
    const threads = [...asking, working];
    expect(
      threadsByAttention(threads, new Map()).indexOf(working),
    ).toBeGreaterThanOrEqual(MAX_THREAD_NODES);
    expect(
      idsOf(
        workingThreadsInGraphOrder(threads, FIXTURE_PROJECTS, new Map(), {}),
      ),
    ).toEqual(['working']);
  });
});

describe('graphBlocks and orderedBlocks', () => {
  it('stands the threads graphBlocks lays out in the order orderedBlocks gives them', () => {
    const threads = [
      thread('a', A, '2026-01-04T00:00:00Z', 'quiet'),
      thread('b', A, '2026-01-03T00:00:00Z', 'working'),
      thread('c', B, '2026-01-02T00:00:00Z', 'question'),
      thread('d', null, '2026-01-01T00:00:00Z', 'working'),
    ];
    const orders: BlockOrders = { [blockIdOf({ projectId: A })]: ['a', 'b'] };
    const shown = threadsByAttention(threads, new Map());
    const fromGraph = graphBlocks(
      shown,
      FIXTURE_PROJECTS,
      new Map(),
      new Map(),
      threads,
      orders,
    ).flatMap((block) => idsOf(block.threads));
    const fromOrder = orderedBlocks(
      shown,
      FIXTURE_PROJECTS,
      new Map(),
      threads,
      orders,
    ).flatMap((block) => idsOf(block.threads));
    expect(fromGraph).toEqual(fromOrder);
    expect(fromGraph).toEqual(['a', 'b', 'c', 'd']);
  });
});
