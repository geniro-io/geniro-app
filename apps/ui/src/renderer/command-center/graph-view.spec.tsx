// @vitest-environment jsdom
import type * as xyflowReactModule from '@xyflow/react';
import type { ReactFlowInstance, ReactFlowProps } from '@xyflow/react';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { NO_PROJECT_BLOCK } from './block-places';
import { BLOCK_ATTENTION_ORDER } from './card-view';
import type { ContactPulse, ContactState } from './contact-edge';
import {
  FIXTURE_NOW,
  FIXTURE_PROJECTS,
  graphThreadsOf,
} from './graph-fixtures';
import type { GraphOpenCard, GraphThread } from './graph-view';
import {
  cardBox,
  graphBlocks,
  GraphView,
  MAX_THREAD_NODES,
  shownThreads,
  wholeFit,
  widthFit,
} from './graph-view';
import { THREAD_CARD_WIDTH, threadCardHeight } from './thread-card';
import { CARD_HEAD_HEIGHT, largestCard } from './thread-card-layer';

const seams = vi.hoisted(() => ({
  setViewport: [] as unknown[][],
  moveStart: null as (() => void) | null,
  flow: null as ReactFlowProps | null,
  flowApi: null as ReactFlowInstance | null,
}));

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof xyflowReactModule>();
  const spied = new WeakMap<object, object>();
  return {
    ...actual,
    ReactFlow: (props: React.ComponentProps<typeof actual.ReactFlow>) => {
      seams.flow = props;
      seams.moveStart =
        props.onMoveStart === undefined
          ? null
          : () => props.onMoveStart?.(null, { x: 0, y: 0, zoom: 1 });
      return <actual.ReactFlow {...props} />;
    },
    useReactFlow: () => {
      const flow = actual.useReactFlow();
      seams.flowApi = flow;
      let wrapped = spied.get(flow);
      if (wrapped === undefined) {
        wrapped = {
          ...flow,
          setViewport: (...args: Parameters<typeof flow.setViewport>) => {
            seams.setViewport.push(args);
            return flow.setViewport(...args);
          },
        };
        spied.set(flow, wrapped);
      }
      return wrapped;
    },
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MINUTE = 60_000;

const MANAGER = {
  agentLabel: 'Claude',
  model: 'opus',
  working: false,
  lastActivityAt: new Date(FIXTURE_NOW - 3 * MINUTE).toISOString(),
};

const settle = async (): Promise<void> => {
  for (let round = 0; round < 40; round += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    });
  }
};

describe('shownThreads', () => {
  it('keeps working cards in place while their threads stream, a newer activity moving none of them', () => {
    const [template] = graphThreadsOf(1);
    const working: GraphThread[] = ['a', 'b', 'c'].map((id, index) => ({
      ...template!,
      id,
      createdAt: new Date(FIXTURE_NOW - (30 - index) * MINUTE).toISOString(),
      view: {
        ...template!.view,
        attention: 'working',
        lastAt: new Date(FIXTURE_NOW - (3 - index) * MINUTE).toISOString(),
      },
    }));
    const before = shownThreads(working).map((thread) => thread.id);
    expect(before).toEqual(['c', 'b', 'a']);

    const streamed = working.map((thread) =>
      thread.id === 'a'
        ? {
            ...thread,
            view: {
              ...thread.view,
              lastAt: new Date(FIXTURE_NOW).toISOString(),
            },
          }
        : thread,
    );

    expect(shownThreads(streamed).map((thread) => thread.id)).toEqual(before);
  });

  it('keeps an open thread past the node cap, even when it stands in the last band', () => {
    const threads = graphThreadsOf(30);
    const shownIds = new Set(shownThreads(threads).map((thread) => thread.id));
    const hidden = threads.find((thread) => !shownIds.has(thread.id))!;
    const band = {
      attention: 'inactive' as const,
      lastAt: '1970-01-01T00:00:00.000Z',
    };

    const shown = shownThreads(threads, new Map([[hidden.id, { band }]]));

    expect(shown).toHaveLength(MAX_THREAD_NODES + 1);
    expect(shown.at(-1)!.id).toBe(hidden.id);
  });

  it('draws an open thread in the band it had when its card opened, not the band it has now', () => {
    const threads = graphThreadsOf(30);
    const shownIds = new Set(shownThreads(threads).map((thread) => thread.id));
    const hidden = threads.find((thread) => !shownIds.has(thread.id))!;
    expect(hidden.view.attention).toBe('inactive');
    const band = {
      attention: 'blocked' as const,
      lastAt: new Date(FIXTURE_NOW).toISOString(),
    };

    const shown = shownThreads(threads, new Map([[hidden.id, { band }]]));

    expect(shown[0]!.id).toBe(hidden.id);
  });
});

describe('wholeFit', () => {
  it('fits the whole graph, the taller side deciding, centred, never past 1', () => {
    expect(
      wholeFit({ width: 800, height: 1200 }, { width: 1000, height: 632 }),
    ).toEqual({ x: 300, y: 16, zoom: 0.5 });
    expect(
      wholeFit({ width: 400, height: 300 }, { width: 1000, height: 632 }),
    ).toEqual({ x: 300, y: 166, zoom: 1 });
  });
});

describe('widthFit', () => {
  it('shrinks a wide graph to the canvas width, from the top, never under the minimum zoom', () => {
    expect(widthFit({ width: 2000 }, { width: 1016 })).toEqual({
      x: 16,
      y: 16,
      zoom: 0.492,
    });
    expect(widthFit({ width: 40_000 }, { width: 1016 }).zoom).toBe(0.25);
  });

  it('centres a narrow graph at its own size rather than zooming it in', () => {
    expect(widthFit({ width: 400 }, { width: 1000 })).toEqual({
      x: 300,
      y: 16,
      zoom: 1,
    });
  });
});

describe('GraphView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    stubResizeObserver();
    vi.stubGlobal(
      'DOMMatrixReadOnly',
      class {
        m22 = 1;
      },
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    seams.setViewport.splice(0);
    seams.moveStart = null;
    seams.flow = null;
    seams.flowApi = null;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function draw(
    overrides: Partial<React.ComponentProps<typeof GraphView>> = {},
  ): Promise<void> {
    act(() => {
      root.render(
        <GraphView
          manager={MANAGER}
          pendingStarts={0}
          threads={[]}
          contacts={{}}
          pulses={[]}
          now={FIXTURE_NOW}
          narrow={false}
          active
          onOpenInChats={() => undefined}
          onToggleCard={() => undefined}
          openCards={[]}
          onCloseCard={() => undefined}
          onResizeCard={() => undefined}
          positions={{}}
          onPlaceNode={() => undefined}
          blockPlaces={{}}
          onPlaceBlock={() => undefined}
          blockOrders={{}}
          onOrderBlock={() => undefined}
          onResetLayout={() => undefined}
          onFocused={() => undefined}
          renderCardChat={() => null}
          focus={null}
          projects={[]}
          asking={new Map()}
          onAnswer={() => undefined}
          onUnplaceNode={() => undefined}
          {...overrides}
        />,
      );
    });
    await settle();
  }

  const all = (slot: string): HTMLElement[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`),
    );

  function threadCard(threadId: string): HTMLElement {
    const card = container.querySelector<HTMLElement>(
      `[data-slot="graph-thread"][data-thread-id="${threadId}"] [data-slot="thread-card"]`,
    );
    if (card === null) {
      throw new Error(`no thread card for ${threadId}`);
    }
    return card;
  }

  function nodeAt(slot: string, id?: string): { x: number; y: number } {
    const inner = container.querySelector<HTMLElement>(
      id === undefined
        ? `[data-slot="${slot}"]`
        : `[data-slot="${slot}"][data-thread-id="${id}"]`,
    )!;
    const wrapper = inner.closest<HTMLElement>('.react-flow__node')!;
    const [, x, y] = /translate\(\s*([-\d.]+)px,\s*([-\d.]+)px\)/.exec(
      wrapper.style.transform,
    )!;
    return { x: Number(x), y: Number(y) };
  }

  function nodeY(slot: string, id?: string): number {
    return nodeAt(slot, id).y;
  }

  function dragCardTo(runId: string, position: { x: number; y: number }): void {
    act(() => {
      seams.flow!.onNodesChange!([
        { type: 'position', id: `thread:${runId}`, position, dragging: true },
      ]);
    });
  }

  function dropCard(runId: string): void {
    act(() => {
      seams.flow!.onNodeDragStop!(
        new MouseEvent('mouseup'),
        flowNode(`thread:${runId}`),
        [],
      );
    });
  }

  it('heads the tree with the manager and hangs every project block under it, wires going down', async () => {
    await draw({ threads: graphThreadsOf(4), projects: FIXTURE_PROJECTS });

    expect(all('graph-manager')).toHaveLength(1);
    expect(all('graph-thread')).toHaveLength(4);
    expect(
      all('contact-edge')
        .map((edge) => edge.dataset.edge)
        .sort(),
    ).toEqual(['contact:block:project-billing', 'contact:block:project-cache']);
    const managerY = nodeY('graph-manager');
    for (const id of ['thread-1', 'thread-2', 'thread-3', 'thread-4']) {
      expect(nodeY('graph-thread', id)).toBeGreaterThan(managerY);
    }
  });

  it('stands each project’s working threads first in its block, the rest after them by attention', async () => {
    const threads = graphThreadsOf(30);
    await draw({ threads });

    expect(all('command-center-graph')[0]!.dataset.layout).toBe('blocks');
    for (const block of graphBlocks(shownThreads(threads), FIXTURE_PROJECTS)) {
      const reading = block.threads
        .map((thread) => ({
          working: thread.view.attention === 'working',
          ...nodeAt('graph-thread', thread.id),
        }))
        .sort((a, b) => a.y - b.y || a.x - b.x);
      const lastWorking = reading.map((card) => card.working).lastIndexOf(true);
      const firstQuiet = reading.findIndex((card) => !card.working);
      expect(lastWorking).toBeLessThan(
        firstQuiet === -1 ? Infinity : firstQuiet,
      );
    }
  });

  it('sizes each card to what it shows, with no padding to a common height', async () => {
    await draw({ threads: graphThreadsOf(6) });

    expect(
      new Set(all('thread-card').map((card) => card.style.minHeight)).size,
    ).toBeGreaterThan(1);
  });

  it('gives a node the height its card is drawn at, so a card whose labels wrap pushes the row under it down', async () => {
    const threads = graphThreadsOf(8);
    const first = threads[0]!.id;
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.threadId === first ? 400 : 0;
      },
    );

    await draw({ threads });

    const top = nodeY('graph-thread', first);
    const below = threads
      .map((thread) => nodeY('graph-thread', thread.id))
      .filter((y) => y > top);
    expect(below.length).toBeGreaterThan(0);
    expect(Math.min(...below)).toBeGreaterThanOrEqual(top + 400);
  });

  it('keys the threads by attention in a legend, with how many stand in each', async () => {
    await draw({ threads: graphThreadsOf(10) });

    const items = all('graph-legend-item').map((item) => item.textContent);
    expect(items).toEqual([
      'Blocked2',
      'Question2',
      'Working2',
      'Quiet2',
      'Inactive a day+2',
    ]);
  });

  it('shows on the manager what it runs: its agent, threads, working, awaiting replies and starts waiting', async () => {
    const contacts: Record<string, ContactState> = {
      'thread-2': {
        lastAt: new Date(FIXTURE_NOW - 40 * MINUTE).toISOString(),
        awaitingReply: true,
      },
    };
    await draw({
      threads: graphThreadsOf(5),
      contacts,
      pendingStarts: 2,
      manager: { ...MANAGER, working: true },
    });

    const manager = all('graph-manager')[0]!;
    expect(
      manager.querySelector('[data-slot="graph-manager-state"]')!.textContent,
    ).toBe('Working');
    expect(
      manager.querySelector('[data-slot="graph-manager-line"]')!.textContent,
    ).toBe('Claude · opus · active 3m ago');
    expect(all('graph-manager-threads')[0]!.textContent).toBe('5threads');
    expect(all('graph-manager-working')[0]!.textContent).toBe('2working');
    expect(all('graph-manager-awaiting')[0]!.textContent).toBe(
      '1awaiting reply',
    );
    expect(all('graph-manager-starts')[0]!.textContent).toBe('2Starts waiting');
  });

  it('keeps the manager on top before its chat exists', async () => {
    await draw({ manager: null, threads: graphThreadsOf(2) });
    const manager = all('graph-manager')[0]!;

    expect(manager.dataset.started).toBe('false');
    expect(manager.textContent).toContain('Not started');
  });

  it('opens nothing from the manager node: it is a summary, not a button', async () => {
    await draw({ threads: graphThreadsOf(2) });
    const manager = all('graph-manager')[0]!;

    expect(manager.tagName).toBe('SECTION');
    expect(manager.querySelector('button')).toBeNull();
  });

  it('draws at most 24 thread cards, the rest as a "+N more" line inside their own project’s block, with one wire per block and none to a "+N more"', async () => {
    const threads = graphThreadsOf(30);
    await draw({ threads, projects: FIXTURE_PROJECTS });

    expect(all('graph-thread')).toHaveLength(MAX_THREAD_NODES);
    const blocks = graphBlocks(
      shownThreads(threads),
      FIXTURE_PROJECTS,
      new Map(),
      new Map(),
      threads,
    );
    const left = blocks.filter((block) => block.footer !== undefined);
    expect(left.length).toBeGreaterThan(0);
    expect(
      left.reduce((sum, block) => sum + block.total - block.threads.length, 0),
    ).toBe(threads.length - MAX_THREAD_NODES);
    expect(nodesOfType('more')).toHaveLength(left.length);
    for (const block of left) {
      const frame = flowNode(block.id);
      const more = flowNode(block.footer!.id);
      expect(more.position.x).toBeGreaterThan(frame.position.x);
      expect(more.position.y + (more.height ?? 0)).toBeLessThan(
        frame.position.y + (frame.height ?? 0),
      );
      expect(more.data).toEqual({ count: block.total - block.threads.length });
    }
    const edges = seams.flow?.edges ?? [];
    expect(edges.map((edge) => edge.target).sort()).toEqual(
      blocks.map((block) => block.id).sort(),
    );
  });

  it('counts every thread of a project in its block’s header, those past the cap included', async () => {
    const threads = graphThreadsOf(30);
    await draw({ threads, projects: FIXTURE_PROJECTS });

    const counted = new Map(
      nodesOfType('block').map((node) => [node.id, node.data.threads]),
    );
    expect(counted).toEqual(
      new Map([
        [
          'block:project-billing',
          threads.filter((thread) => thread.projectId === 'project-billing')
            .length,
        ],
        [
          'block:project-cache',
          threads.filter((thread) => thread.projectId === 'project-cache')
            .length,
        ],
        [
          NO_PROJECT_BLOCK,
          threads.filter((thread) => thread.projectId === null).length,
        ],
      ]),
    );
  });

  it('draws the 24 that need the user most, the still ones left to "+N more"', () => {
    const shown = shownThreads(graphThreadsOf(30));
    const rank = (thread: GraphThread): number =>
      ['blocked', 'question', 'working', 'quiet', 'inactive'].indexOf(
        thread.view.attention,
      );

    expect(shown).toHaveLength(MAX_THREAD_NODES);
    expect(shown.map(rank)).toEqual([...shown.map(rank)].sort((a, b) => a - b));
    expect(
      shown.filter((thread) => thread.view.attention === 'inactive').length,
    ).toBeLessThan(
      graphThreadsOf(30).filter(
        (thread) => thread.view.attention === 'inactive',
      ).length,
    );
  });

  it('takes a thread to Chats only from its Open in Chats icon, never from a click on the card', async () => {
    const onOpenInChats = vi.fn();
    const onToggleCard = vi.fn();
    await draw({ threads: graphThreadsOf(3), onOpenInChats, onToggleCard });

    act(() => threadCard('thread-2').click());
    expect(onOpenInChats).not.toHaveBeenCalled();
    expect(onToggleCard).not.toHaveBeenCalled();

    act(() =>
      threadCard('thread-2')
        .querySelector<HTMLButtonElement>(
          '[data-slot="thread-head-open-in-chats"]',
        )!
        .click(),
    );
    expect(onOpenInChats).toHaveBeenCalledWith('thread-2');
    expect(onToggleCard).not.toHaveBeenCalled();
  });

  it('turns a thread into its card from its Show chat icon and from its title, not by navigating to it', async () => {
    const onOpenInChats = vi.fn();
    const onToggleCard = vi.fn();
    await draw({ threads: graphThreadsOf(3), onOpenInChats, onToggleCard });

    act(() =>
      threadCard('thread-3')
        .querySelector<HTMLButtonElement>(
          '[data-slot="thread-head-show-chat"]',
        )!
        .click(),
    );
    act(() =>
      threadCard('thread-3')
        .querySelector<HTMLButtonElement>('[data-slot="thread-card-title"]')!
        .click(),
    );

    expect(onToggleCard).toHaveBeenNthCalledWith(1, 'thread-3');
    expect(onToggleCard).toHaveBeenNthCalledWith(2, 'thread-3');
    expect(onOpenInChats).not.toHaveBeenCalled();
  });

  it('draws no project legend, on wide or narrow, and marks each card with its project’s dot', async () => {
    await draw({ threads: graphThreadsOf(3), projects: FIXTURE_PROJECTS });

    expect(all('graph-projects')).toHaveLength(0);
    expect(all('graph-project')).toHaveLength(0);
    expect(
      threadCard('thread-1')
        .querySelector('[data-slot="thread-card-project-dot"]')!
        .getAttribute('data-color'),
    ).toBe('blue');
    expect(
      threadCard('thread-2')
        .querySelector('[data-slot="thread-card-project-dot"]')!
        .getAttribute('data-color'),
    ).toBe('purple');

    await draw({
      threads: graphThreadsOf(3),
      projects: FIXTURE_PROJECTS,
      narrow: true,
    });
    expect(all('graph-projects')).toHaveLength(0);
    expect(all('graph-project')).toHaveLength(0);
  });

  it('offers Answer only on a thread holding a card for the user, and answers it here rather than opening it', async () => {
    const onAnswer = vi.fn();
    const onOpenInChats = vi.fn();
    const onToggleCard = vi.fn();
    await draw({
      threads: graphThreadsOf(3),
      asking: new Map([['thread-2', 'approval' as const]]),
      onAnswer,
      onOpenInChats,
      onToggleCard,
    });

    expect(
      threadCard('thread-1').querySelector('[data-slot="thread-card-answer"]'),
    ).toBeNull();
    expect(
      threadCard('thread-2').querySelector('[data-slot="thread-card-answer"]')!
        .textContent,
    ).toBe('Review');
    const button = threadCard('thread-2').querySelector<HTMLButtonElement>(
      '[data-slot="thread-card-answer"]',
    )!;
    act(() => button.click());
    expect(onAnswer).toHaveBeenCalledWith('thread-2', button);
    expect(onOpenInChats).not.toHaveBeenCalled();
    expect(onToggleCard).not.toHaveBeenCalled();
  });

  it('shows a thread’s board card as a label on its node, with no node of its own', async () => {
    await draw({ threads: graphThreadsOf(3) });

    expect(
      threadCard('thread-1').querySelector(
        '[data-slot="thread-card-board-card"]',
      )!.textContent,
    ).toContain('QA-1');
    expect(
      threadCard('thread-2').querySelector(
        '[data-slot="thread-card-board-card"]',
      ),
    ).toBeNull();
    expect(all('graph-task')).toHaveLength(0);
  });

  it('names each card’s contact state for a screen reader, and paints each block’s wire in its loudest thread’s state', async () => {
    const contacts: Record<string, ContactState> = {
      'thread-1': {
        lastAt: new Date(FIXTURE_NOW - 2 * MINUTE).toISOString(),
        awaitingReply: false,
      },
      'thread-2': {
        lastAt: new Date(FIXTURE_NOW - 40 * MINUTE).toISOString(),
        awaitingReply: true,
      },
    };
    await draw({ threads: graphThreadsOf(3), contacts });
    const state = (id: string) =>
      container
        .querySelector(`[data-edge="contact:${id}"]`)
        ?.getAttribute('data-state');

    expect(threadCard('thread-2').getAttribute('aria-label')).toBe(
      'Rebase billing on main, Waiting on you, Question, awaiting a reply, last contact 40m ago',
    );
    expect(state('block:project-billing')).toBe('lit');
    expect(state('block:project-cache')).toBe('awaiting');
  });

  it('gives each block’s wire the pulses of every thread in it that no pin takes out', async () => {
    const pulse: ContactPulse = {
      id: 'pulse-1',
      threadId: 'thread-3',
      at: new Date(FIXTURE_NOW).toISOString(),
      direction: 'out',
    };
    await draw({ threads: graphThreadsOf(4), pulses: [pulse] });

    const edge = (seams.flow?.edges ?? []).find(
      (candidate) => candidate.id === 'contact:block:project-billing',
    );
    expect(edge?.data?.pulses).toEqual([pulse]);
  });

  it('keeps every block wire drawn when a reply rebuilds the cards, its state moving from awaiting to lit', async () => {
    const threads = graphThreadsOf(3);
    const sentAt = new Date(FIXTURE_NOW - MINUTE).toISOString();
    await draw({
      threads,
      contacts: { 'thread-1': { lastAt: sentAt, awaitingReply: true } },
    });
    expect(all('contact-edge')).toHaveLength(2);

    await draw({
      threads: threads.map((thread) => ({ ...thread })),
      contacts: {
        'thread-1': {
          lastAt: new Date(FIXTURE_NOW).toISOString(),
          awaitingReply: false,
        },
      },
    });

    expect(all('contact-edge')).toHaveLength(2);
    expect(
      container
        .querySelector('[data-edge="contact:block:project-billing"]')
        ?.getAttribute('data-state'),
    ).toBe('lit');
  });

  it('lets the pointer reach every card and node, while a block frame passes it through to the canvas', async () => {
    await draw({ threads: graphThreadsOf(2), projects: FIXTURE_PROJECTS });

    const wrappers = Array.from(
      container.querySelectorAll<HTMLElement>('.react-flow__node'),
    );
    expect(wrappers.length).toBeGreaterThan(0);
    for (const wrapper of wrappers) {
      const frame = wrapper.querySelector('[data-slot="project-block"]');
      expect(wrapper.style.pointerEvents).toBe(frame === null ? 'all' : 'none');
    }
    expect(all('project-block')).toHaveLength(2);
  });

  it('lays a phone out as one column it scrolls, every project’s cards under its heading in block order', async () => {
    const threads = graphThreadsOf(4);
    await draw({ threads, narrow: true, projects: FIXTURE_PROJECTS });

    const graph = all('command-center-graph')[0]!;
    expect(graph.dataset.layout).toBe('column');
    const ys = graphBlocks(shownThreads(threads), FIXTURE_PROJECTS)
      .flatMap((block) => block.threads)
      .map((thread) => nodeY('graph-thread', thread.id));
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys[0]).toBeGreaterThan(nodeY('graph-manager'));
    expect(all('contact-edge')).toHaveLength(4);
  });

  it('frames each project’s cards in the phone column, headed by its name, in its colour, and never movable there', async () => {
    const threads = graphThreadsOf(4);
    await draw({ threads, narrow: true, projects: FIXTURE_PROJECTS });

    expect(all('project-block').map((frame) => frame.dataset.color)).toEqual([
      'blue',
      'purple',
    ]);
    expect(
      all('project-block-header').map((header) => header.textContent),
    ).toEqual([
      expect.stringContaining('QA Billing'),
      expect.stringContaining('QA Cache'),
    ]);
    for (const block of graphBlocks(shownThreads(threads), FIXTURE_PROJECTS)) {
      const frame = flowNode(block.id);
      expect(frame.draggable).toBe(false);
      for (const thread of block.threads) {
        const card = flowNode(`thread:${thread.id}`);
        expect(card.position.y).toBeGreaterThan(frame.position.y);
        expect(card.position.x).toBeGreaterThan(frame.position.x);
        expect(card.position.y + (card.height ?? 0)).toBeLessThan(
          frame.position.y + (frame.height ?? 0),
        );
      }
    }
    expect(
      container.querySelector(
        '[data-slot="project-block-header"].cc-block-handle',
      ),
    ).toBeNull();
  });

  it('puts the phone column’s flow pane under flow-touch-scroll, so a finger swipe scrolls the page rather than being eaten by the pane', async () => {
    await draw({ threads: graphThreadsOf(4), narrow: true });

    const pane = container.querySelector('.react-flow__pane')!;
    expect(pane.closest('.flow-touch-scroll')).not.toBeNull();
  });

  it('leaves the desktop canvas’s pane to React Flow, which pans it by drag', async () => {
    await draw({ threads: graphThreadsOf(4), narrow: false });

    const pane = container.querySelector('.react-flow__pane')!;
    expect(pane.closest('.flow-touch-scroll')).toBeNull();
  });

  it('draws an open thread as a slot in the graph, with its card over the slot holding the chat renderCardChat gives', async () => {
    await draw({
      threads: graphThreadsOf(3),
      openCards: [openCard('thread-2')],
      renderCardChat: (threadId) => (
        <span data-slot="card-chat">{`chat of ${threadId}`}</span>
      ),
    });

    expect(all('graph-slot').map((slot) => slot.dataset.threadId)).toEqual([
      'thread-2',
    ]);
    expect(
      container.querySelector(
        '[data-slot="graph-thread"][data-thread-id="thread-2"]',
      ),
    ).toBeNull();
    const cards = all('thread-canvas-card');
    expect(cards.map((card) => card.dataset.runId)).toEqual(['thread-2']);
    expect(
      cards[0]!.querySelector('[data-slot="card-chat"]')!.textContent,
    ).toBe('chat of thread-2');
  });

  it('keeps the flow and each open card’s chat mounted while the page is hidden and measures 0×0', async () => {
    const previous = globalThis.ResizeObserver;
    const canvasSizes: ((entries: ResizeObserverEntry[]) => void)[] = [];
    globalThis.ResizeObserver = class {
      private readonly callback: (entries: ResizeObserverEntry[]) => void;

      constructor(callback: (entries: ResizeObserverEntry[]) => void) {
        this.callback = callback;
      }

      observe(target: Element): void {
        if (target.parentElement?.dataset.slot === 'command-center-graph') {
          canvasSizes.push(this.callback);
        }
      }

      unobserve(): void {}

      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    const mounts: string[] = [];
    function CardChat({ threadId }: { threadId: string }): React.JSX.Element {
      useEffect(() => {
        mounts.push(threadId);
      }, [threadId]);
      return <span data-slot="card-chat">{threadId}</span>;
    }
    const resize = (width: number, height: number): void =>
      act(() => {
        canvasSizes.at(-1)!([
          { contentRect: { width, height } },
        ] as unknown as ResizeObserverEntry[]);
      });
    try {
      await draw({
        threads: graphThreadsOf(3),
        openCards: [openCard('thread-2')],
        renderCardChat: (threadId) => <CardChat threadId={threadId} />,
      });
      expect(mounts).toEqual(['thread-2']);

      resize(0, 0);
      expect(container.querySelector('.react-flow')).not.toBeNull();
      expect(all('card-chat').map((chat) => chat.textContent)).toEqual([
        'thread-2',
      ]);

      resize(1200, 700);
      expect(mounts).toEqual(['thread-2']);
    } finally {
      globalThis.ResizeObserver = previous;
    }
  });

  it('draws no card for a collapsed thread, and asks for no chat of it', async () => {
    const renderCardChat = vi.fn(
      (threadId: string): string => `chat of ${threadId}`,
    );
    await draw({
      threads: graphThreadsOf(3),
      openCards: [openCard('thread-2')],
      renderCardChat,
    });

    expect(
      all('graph-thread')
        .map((node) => node.dataset.threadId)
        .sort(),
    ).toEqual(['thread-1', 'thread-3']);
    expect(all('thread-canvas-card').map((card) => card.dataset.runId)).toEqual(
      ['thread-2'],
    );
    expect(
      new Set(renderCardChat.mock.calls.map(([threadId]) => threadId)),
    ).toEqual(new Set(['thread-2']));
  });

  it('does not refit the graph when a card opens, and refits once the graph grows wider', async () => {
    await draw({ threads: graphThreadsOf(3) });
    seams.setViewport.splice(0);

    await draw({
      threads: graphThreadsOf(3),
      openCards: [openCard('thread-2')],
    });
    expect(seams.setViewport).toEqual([]);

    await draw({
      threads: graphThreadsOf(12),
      openCards: [openCard('thread-2')],
    });
    expect(seams.setViewport.length).toBeGreaterThan(0);
  });

  it('hands a focus over at once on the narrow column, with no pan to wait for', async () => {
    const onFocused = vi.fn();

    await draw({
      threads: graphThreadsOf(4),
      narrow: true,
      focus: { runId: 'thread-3', seq: 7 },
      onFocused,
    });

    expect(onFocused).toHaveBeenCalledWith(7);
    expect(onFocused).toHaveBeenCalledTimes(1);
    expect(seams.setViewport).toEqual([]);
  });

  it('hands a focus over after its pan, and the pan is no move the viewer made', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const onViewportMove = vi.fn();
    const onFocused = vi.fn();
    await draw({ threads: graphThreadsOf(3), onViewportMove });

    clock.mockReturnValue(5_000);
    await draw({
      threads: graphThreadsOf(3),
      onViewportMove,
      focus: { runId: 'thread-2', seq: 1 },
      onFocused,
    });
    expect(onFocused).toHaveBeenCalledWith(1);

    act(() => seams.moveStart?.());
    expect(onViewportMove).not.toHaveBeenCalled();

    clock.mockReturnValue(6_000);
    act(() => seams.moveStart?.());
    expect(onViewportMove).toHaveBeenCalledTimes(1);
  });

  it('draws a stored card no bigger than the pane, its slot and its card agreeing on that size', async () => {
    const largest = largestCard({ width: 1200, height: 700 });
    expect(largest.width).toBe(1200 - 32);

    await draw({
      threads: graphThreadsOf(3),
      openCards: [openCard('thread-2', { width: 2000, height: 2000 })],
    });

    const node = container
      .querySelector<HTMLElement>(
        '[data-slot="graph-slot"][data-thread-id="thread-2"]',
      )!
      .closest<HTMLElement>('.react-flow__node')!;
    expect(node.style.width).toBe(`${largest.width}px`);
    expect(node.style.height).toBe(`${CARD_HEAD_HEIGHT + largest.height}px`);
    const card = container.querySelector<HTMLElement>(
      '[data-slot="thread-canvas-card"][data-run-id="thread-2"]',
    )!;
    expect(card.style.width).toBe(`${largest.width}px`);
    expect(card.style.height).toBe(`${CARD_HEAD_HEIGHT + largest.height}px`);
  });

  it('flashes the open card the graph pans to', async () => {
    await draw({
      threads: graphThreadsOf(3),
      openCards: [openCard('thread-2')],
      focus: { runId: 'thread-2', seq: 1 },
      onFocused: () => undefined,
    });

    expect(
      container.querySelector(
        '[data-slot="thread-canvas-card"][data-run-id="thread-2"] [data-slot="thread-canvas-card-flash"]',
      ),
    ).not.toBeNull();
  });

  it('lets a thread node be dragged on a wide canvas, and no other node', async () => {
    await draw({
      threads: graphThreadsOf(30),
      openCards: [openCard('thread-2')],
    });

    const threadNodes = nodesOfType('thread');
    expect(threadNodes.length).toBeGreaterThan(0);
    expect(threadNodes.every((node) => node.draggable === true)).toBe(true);
    for (const type of ['manager', 'slot', 'more']) {
      const nodes = nodesOfType(type);
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.every((node) => node.draggable === false)).toBe(true);
    }
    expect(seams.flow?.nodeDragThreshold).toBe(5);
  });

  it('lets no node be dragged on a phone, where the column is the layout', async () => {
    await draw({ threads: graphThreadsOf(3), narrow: true });

    const nodes = seams.flow?.nodes ?? [];
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.every((node) => node.draggable === false)).toBe(true);
  });

  it('moves a dragged thread node with the pointer, and on release outside its block places it at the drop, relative to the manager', async () => {
    const onPlaceNode = vi.fn();
    const onUnplaceNode = vi.fn();
    await draw({ threads: graphThreadsOf(3), onPlaceNode, onUnplaceNode });
    const start = flowNode('thread:thread-1').position;
    const to = { x: start.x + 1000, y: start.y };

    act(() => {
      seams.flow!.onNodesChange!([
        {
          type: 'position',
          id: 'thread:thread-1',
          position: to,
          dragging: true,
        },
      ]);
    });
    const during = nodeAt('graph-thread', 'thread-1');
    expect(during.x).toBeCloseTo(to.x, 5);
    expect(during.y).toBeCloseTo(to.y, 5);
    expect(onPlaceNode).not.toHaveBeenCalled();

    act(() => {
      seams.flow!.onNodeDragStop!(
        new MouseEvent('mouseup'),
        flowNode('thread:thread-1'),
        [],
      );
    });
    const manager = nodesOfType('manager')[0]!.position;
    expect(onPlaceNode).toHaveBeenCalledTimes(1);
    expect(onPlaceNode).toHaveBeenCalledWith('thread-1', {
      x: to.x - manager.x,
      y: to.y - manager.y,
    });
    expect(onUnplaceNode).not.toHaveBeenCalled();
  });

  it('takes a card dropped back inside its own block off its pin, and places it nowhere', async () => {
    const onPlaceNode = vi.fn();
    const onUnplaceNode = vi.fn();
    await draw({ threads: graphThreadsOf(4) });
    const home = flowNode('block:project-billing').position;

    await draw({
      threads: graphThreadsOf(4),
      positions: { 'thread-1': { x: 900, y: 600 } },
      onPlaceNode,
      onUnplaceNode,
    });
    const inside = { x: home.x + 16, y: home.y + 40 };
    act(() => {
      seams.flow!.onNodesChange!([
        {
          type: 'position',
          id: 'thread:thread-1',
          position: inside,
          dragging: true,
        },
      ]);
    });
    act(() => {
      seams.flow!.onNodeDragStop!(
        new MouseEvent('mouseup'),
        flowNode('thread:thread-1'),
        [],
      );
    });

    expect(onUnplaceNode).toHaveBeenCalledWith('thread-1');
    expect(onPlaceNode).not.toHaveBeenCalled();
  });

  it('shows a free slot the size of the card while it is dragged into its own block, and none over another project block, where its own block shrinks', async () => {
    await draw({ threads: graphThreadsOf(4), projects: FIXTURE_PROJECTS });
    const card = flowNode('thread:thread-1');
    const home = blockSize('block:project-billing');
    const billing = flowNode('block:project-billing').position;
    const cache = flowNode('block:project-cache').position;

    dragCardTo('thread-1', { x: billing.x + 16, y: billing.y + 40 });
    expect(nodesOfType('dropSlot').map((node) => node.id)).toEqual([
      'drop:thread-1',
    ]);
    expect(nodesOfType('dropSlot')[0]).toMatchObject({
      width: card.width,
      height: card.height,
    });
    expect(all('graph-drop-slot')).toHaveLength(1);

    dragCardTo('thread-1', { x: cache.x + 10, y: cache.y + 10 });
    expect(nodesOfType('dropSlot')).toEqual([]);
    expect(all('graph-drop-slot')).toHaveLength(0);
    expect(blockSize('block:project-billing').width).toBeLessThan(home.width);
  });

  it('orders a card dropped into its own block after the block’s other card, and places nothing', async () => {
    const onPlaceNode = vi.fn();
    const onUnplaceNode = vi.fn();
    const onOrderBlock = vi.fn();
    await draw({
      threads: graphThreadsOf(4),
      projects: FIXTURE_PROJECTS,
      blockOrders: { 'block:project-billing': ['thread-1', 'thread-3'] },
      onPlaceNode,
      onUnplaceNode,
      onOrderBlock,
    });
    const other = flowNode('thread:thread-3');

    dragCardTo('thread-1', other.position);
    dropCard('thread-1');

    expect(onOrderBlock).toHaveBeenCalledTimes(1);
    expect(onOrderBlock).toHaveBeenCalledWith('block:project-billing', [
      'thread-3',
      'thread-1',
    ]);
    expect(onPlaceNode).not.toHaveBeenCalled();
    expect(onUnplaceNode).not.toHaveBeenCalled();
  });

  it('neither orders nor places a card dropped back where it stood', async () => {
    const onPlaceNode = vi.fn();
    const onOrderBlock = vi.fn();
    await draw({
      threads: graphThreadsOf(4),
      projects: FIXTURE_PROJECTS,
      onPlaceNode,
      onOrderBlock,
    });
    const home = flowNode('thread:thread-1').position;

    dragCardTo('thread-1', home);
    dropCard('thread-1');

    expect(onOrderBlock).not.toHaveBeenCalled();
    expect(onPlaceNode).not.toHaveBeenCalled();
  });

  it('places a card dropped outside its own block where it lands, and orders no block', async () => {
    const onPlaceNode = vi.fn();
    const onOrderBlock = vi.fn();
    await draw({
      threads: graphThreadsOf(4),
      projects: FIXTURE_PROJECTS,
      onPlaceNode,
      onOrderBlock,
    });
    const cache = flowNode('block:project-cache').position;
    const manager = nodesOfType('manager')[0]!.position;
    const to = { x: cache.x + 10, y: cache.y + 10 };

    dragCardTo('thread-1', to);
    dropCard('thread-1');

    expect(onPlaceNode).toHaveBeenCalledWith('thread-1', {
      x: to.x - manager.x,
      y: to.y - manager.y,
    });
    expect(onOrderBlock).not.toHaveBeenCalled();
  });

  it('takes a pinned card off its pin and orders its block with it at the drop, when it is dropped inside the block', async () => {
    const onPlaceNode = vi.fn();
    const onUnplaceNode = vi.fn();
    const onOrderBlock = vi.fn();
    await draw({
      threads: graphThreadsOf(4),
      positions: { 'thread-1': { x: 900, y: 600 } },
      onPlaceNode,
      onUnplaceNode,
      onOrderBlock,
    });
    const other = flowNode('thread:thread-3');

    dragCardTo('thread-1', {
      x: other.position.x + (other.width ?? 0),
      y: other.position.y,
    });
    dropCard('thread-1');

    expect(onUnplaceNode).toHaveBeenCalledWith('thread-1');
    expect(onOrderBlock).toHaveBeenCalledWith('block:project-billing', [
      'thread-3',
      'thread-1',
    ]);
    expect(onPlaceNode).not.toHaveBeenCalled();
  });

  it('holds every other block frame where and as big as it was drawn while a card is dragged, until the drop', async () => {
    await draw({ threads: graphThreadsOf(4), projects: FIXTURE_PROJECTS });
    const frames = () =>
      nodesOfType('block').map((node) => ({
        id: node.id,
        position: node.position,
        width: node.width,
        height: node.height,
      }));
    const others = () =>
      frames().filter((frame) => frame.id !== 'block:project-billing');
    const before = others();
    const start = flowNode('thread:thread-1').position;
    const cache = flowNode('block:project-cache').position;
    const dragTo = (position: { x: number; y: number }): void => {
      act(() => {
        seams.flow!.onNodesChange!([
          { type: 'position', id: 'thread:thread-1', position, dragging: true },
        ]);
      });
    };

    dragTo({ x: start.x + 30, y: start.y + 20 });
    expect(others()).toEqual(before);
    dragTo({ x: cache.x + 10, y: cache.y + 10 });
    expect(others()).toEqual(before);
    expect(nodeAt('graph-thread', 'thread-1')).toEqual({
      x: cache.x + 10,
      y: cache.y + 10,
    });
  });

  it('takes a pinned card dropped on its block’s frame where the frame is drawn off its pin', async () => {
    const onPlaceNode = vi.fn();
    const onUnplaceNode = vi.fn();
    await draw({
      threads: graphThreadsOf(4),
      positions: { 'thread-1': { x: 900, y: 600 } },
      onPlaceNode,
      onUnplaceNode,
    });
    const card = flowNode('thread:thread-1');
    const frameNow = () => flowNode('block:project-billing');
    const dragTo = (position: { x: number; y: number }): void => {
      act(() => {
        seams.flow!.onNodesChange!([
          { type: 'position', id: 'thread:thread-1', position, dragging: true },
        ]);
      });
    };
    const first = frameNow();
    dragTo({
      x: first.position.x + (first.width ?? 0) - 20,
      y: first.position.y + 10,
    });
    const drawn = frameNow();
    dragTo({
      x: drawn.position.x + (drawn.width ?? 0) / 2 - (card.width ?? 0) / 2,
      y: drawn.position.y + 40,
    });
    act(() => {
      seams.flow!.onNodeDragStop!(
        new MouseEvent('mouseup'),
        flowNode('thread:thread-1'),
        [],
      );
    });

    expect(onUnplaceNode).toHaveBeenCalledWith('thread-1');
    expect(onPlaceNode).not.toHaveBeenCalled();
  });

  it('gives a card dropped out of its block its own wire, and shrinks the block around the cards left in it', async () => {
    await draw({ threads: graphThreadsOf(4) });
    const whole = blockSize('block:project-billing');

    await draw({
      threads: graphThreadsOf(4),
      positions: { 'thread-1': { x: 900, y: 600 } },
    });
    const shrunk = blockSize('block:project-billing');
    expect(shrunk.width).toBeLessThan(whole.width);
    expect(shrunk.height).toBeLessThanOrEqual(whole.height);
    expect(
      container.querySelector('[data-edge="contact:thread-1"]'),
    ).not.toBeNull();
    expect(all('contact-edge')).toHaveLength(3);

    await draw({ threads: graphThreadsOf(4) });
    expect(blockSize('block:project-billing')).toEqual(whole);
  });

  it('draws each project block behind its threads, with no pointer of its own but its header, which drags it', async () => {
    await draw({ threads: graphThreadsOf(4), projects: FIXTURE_PROJECTS });

    const blocks = nodesOfType('block');
    expect(blocks.map((node) => node.id)).toEqual([
      'block:project-billing',
      'block:project-cache',
    ]);
    for (const node of blocks) {
      expect(node.zIndex).toBe(-1);
      expect(node.style?.pointerEvents).toBe('none');
      expect(node.draggable).toBe(true);
      expect(node.dragHandle).toBe('.cc-block-handle');
      expect(node.selectable).toBe(false);
    }
    expect(
      all('project-block-header').every((header) =>
        header.classList.contains('cc-block-handle'),
      ),
    ).toBe(true);
    expect(all('project-block').map((frame) => frame.dataset.color)).toEqual([
      'blue',
      'purple',
    ]);
  });

  it('stands a block’s threads in the order the user set for them, read left to right', async () => {
    const threads = graphThreadsOf(4);
    const automatic = graphBlocks(shownThreads(threads), FIXTURE_PROJECTS)
      .find((block) => block.id === 'block:project-billing')!
      .threads.map((thread) => thread.id);
    const stored = [...automatic].reverse();

    await draw({
      threads,
      projects: FIXTURE_PROJECTS,
      blockOrders: { 'block:project-billing': stored },
    });

    const reading = automatic
      .map((id) => ({ id, ...nodeAt('graph-thread', id) }))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((card) => card.id);
    expect(reading).toEqual(stored);
  });

  it('moves a dragged project block with its threads by the same offset, leaves the other block where it stood, and places it on release', async () => {
    const onPlaceBlock = vi.fn();
    await draw({
      threads: graphThreadsOf(4),
      projects: FIXTURE_PROJECTS,
      onPlaceBlock,
    });
    const billing = flowNode('block:project-billing').position;
    const billingThreads = ['thread-1', 'thread-3'];
    const threadsBefore = billingThreads.map((id) =>
      nodeAt('graph-thread', id),
    );
    const cacheBefore = flowNode('block:project-cache').position;
    const cacheThreadBefore = nodeAt('graph-thread', 'thread-2');
    const to = { x: billing.x + 200, y: billing.y + 100 };

    act(() => {
      seams.flow!.onNodesChange!([
        {
          type: 'position',
          id: 'block:project-billing',
          position: to,
          dragging: true,
        },
      ]);
    });

    expect(flowNode('block:project-billing').position.x).toBeCloseTo(to.x, 5);
    expect(flowNode('block:project-billing').position.y).toBeCloseTo(to.y, 5);
    billingThreads.forEach((id, index) => {
      expect(nodeAt('graph-thread', id).x).toBeCloseTo(
        threadsBefore[index]!.x + 200,
        5,
      );
      expect(nodeAt('graph-thread', id).y).toBeCloseTo(
        threadsBefore[index]!.y + 100,
        5,
      );
    });
    expect(flowNode('block:project-cache').position).toEqual(cacheBefore);
    expect(nodeAt('graph-thread', 'thread-2')).toEqual(cacheThreadBefore);
    expect(onPlaceBlock).not.toHaveBeenCalled();

    const manager = nodesOfType('manager')[0]!.position;
    act(() => {
      seams.flow!.onNodeDragStop!(
        new MouseEvent('mouseup'),
        { ...flowNode('block:project-billing'), position: to },
        [],
      );
    });

    expect(onPlaceBlock).toHaveBeenCalledTimes(1);
    expect(onPlaceBlock).toHaveBeenCalledWith('block:project-billing', {
      x: to.x - manager.x,
      y: to.y - manager.y,
    });
  });

  it('stands a project block where it was left, offset from the manager node', async () => {
    await draw({
      threads: graphThreadsOf(4),
      projects: FIXTURE_PROJECTS,
      blockPlaces: { 'block:project-billing': { x: 300, y: 500 } },
    });
    const manager = nodesOfType('manager')[0]!.position;
    const billing = flowNode('block:project-billing').position;

    expect(billing.x).toBeCloseTo(manager.x + 300, 5);
    expect(billing.y).toBeCloseTo(manager.y + 500, 5);
  });

  it('heads each project block with its name, its thread count and how many of its threads work', async () => {
    await draw({ threads: graphThreadsOf(4), projects: FIXTURE_PROJECTS });

    const header = (name: string) =>
      all('project-block-header').find((element) =>
        element.textContent?.includes(name),
      )?.textContent;
    expect(header('QA Billing')).toBe('QA Billing2 · 1 working');
    expect(header('QA Cache')).toBe('QA Cache2');
  });

  it('draws a thread at the place it was left, offset from the manager node', async () => {
    await draw({
      threads: graphThreadsOf(3),
      positions: { 'thread-2': { x: 240, y: 360 } },
    });

    const manager = nodeAt('graph-manager');
    const placed = nodeAt('graph-thread', 'thread-2');
    expect(placed.x).toBeCloseTo(manager.x + 240, 5);
    expect(placed.y).toBeCloseTo(manager.y + 360, 5);
  });

  it('offers Reset layout only while a node keeps a place of its own, and gives the automatic layout back on a click', async () => {
    const onResetLayout = vi.fn();
    const resetButton = () =>
      container.querySelector<HTMLButtonElement>(
        '[data-slot="graph-reset-layout"]',
      );
    await draw({ threads: graphThreadsOf(3), onResetLayout });
    expect(resetButton()).toBeNull();

    await draw({
      threads: graphThreadsOf(3),
      positions: { 'thread-2': { x: 240, y: 360 } },
      onResetLayout,
    });
    expect(resetButton()).not.toBeNull();
    act(() => resetButton()!.click());

    expect(onResetLayout).toHaveBeenCalledTimes(1);
  });

  it('offers Reset layout once a block keeps a place or an order of its own, and not while none does', async () => {
    const onResetLayout = vi.fn();
    const resetButton = () =>
      container.querySelector<HTMLButtonElement>(
        '[data-slot="graph-reset-layout"]',
      );
    await draw({
      threads: graphThreadsOf(4),
      projects: FIXTURE_PROJECTS,
      onResetLayout,
    });
    expect(resetButton()).toBeNull();

    await draw({
      threads: graphThreadsOf(4),
      projects: FIXTURE_PROJECTS,
      blockPlaces: { 'block:project-billing': { x: 300, y: 500 } },
      onResetLayout,
    });
    expect(resetButton()).not.toBeNull();

    await draw({
      threads: graphThreadsOf(4),
      projects: FIXTURE_PROJECTS,
      blockOrders: { 'block:project-billing': ['thread-3', 'thread-1'] },
      onResetLayout,
    });
    expect(resetButton()).not.toBeNull();
    act(() => resetButton()!.click());

    expect(onResetLayout).toHaveBeenCalledTimes(1);
  });

  it('keeps the manager where it stood when a card opens wider than its node, so moved nodes stay put', async () => {
    await draw({
      threads: graphThreadsOf(6),
      positions: { 'thread-5': { x: -300, y: 400 } },
    });
    const manager = nodeAt('graph-manager');
    const moved = nodeAt('graph-thread', 'thread-5');

    await draw({
      threads: graphThreadsOf(6),
      positions: { 'thread-5': { x: -300, y: 400 } },
      openCards: [openCard('thread-2', { width: 900, height: 420 })],
    });

    expect(nodeAt('graph-manager')).toEqual(manager);
    expect(nodeAt('graph-thread', 'thread-5')).toEqual(moved);
  });

  it('moves an open card’s slot with its head, and on a drop outside its block places it relative to the manager', async () => {
    Element.prototype.setPointerCapture = vi.fn();
    const onPlaceNode = vi.fn();
    const onUnplaceNode = vi.fn();
    await draw({
      threads: graphThreadsOf(3),
      openCards: [openCard('thread-2')],
      onPlaceNode,
      onUnplaceNode,
    });
    const start = nodeAt('graph-slot', 'thread-2');
    const head = container.querySelector<HTMLElement>(
      '[data-slot="thread-canvas-card"][data-run-id="thread-2"] [data-slot="thread-canvas-card-head"]',
    )!;
    const press = (type: string, x: number, y: number): void => {
      act(() => {
        head.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            button: 0,
            clientX: x,
            clientY: y,
          }),
        );
      });
    };

    press('pointerdown', 100, 100);
    press('pointermove', 1000, 140);
    const during = nodeAt('graph-slot', 'thread-2');
    expect(during.x).toBeCloseTo(start.x + 900, 5);
    expect(during.y).toBeCloseTo(start.y + 40, 5);
    expect(onPlaceNode).not.toHaveBeenCalled();

    press('pointerup', 1000, 140);
    const manager = nodeAt('graph-manager');
    expect(onPlaceNode).toHaveBeenCalledWith('thread-2', {
      x: start.x + 900 - manager.x,
      y: start.y + 40 - manager.y,
    });
    expect(onUnplaceNode).not.toHaveBeenCalled();
  });

  it('moves a dragged card’s wire with it at once, while every other block wire keeps gliding', async () => {
    Element.prototype.setPointerCapture = vi.fn();
    await draw({
      threads: graphThreadsOf(3),
      openCards: [openCard('thread-2')],
    });
    const head = container.querySelector<HTMLElement>(
      '[data-slot="thread-canvas-card"][data-run-id="thread-2"] [data-slot="thread-canvas-card-head"]',
    )!;
    const wire = (id: string): HTMLElement =>
      container.querySelector<HTMLElement>(
        `[data-slot="contact-edge"][data-edge="contact:${id}"]`,
      )!;
    const press = (type: string, x: number, y: number): void => {
      act(() => {
        head.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            button: 0,
            clientX: x,
            clientY: y,
          }),
        );
      });
    };

    press('pointerdown', 100, 100);
    press('pointermove', 160, 140);
    expect(wire('thread-2').dataset.moving).toBe('true');
    expect(
      wire('thread-2').querySelector('path')!.getAttribute('class'),
    ).toMatch(/(^|\s)transition-none(\s|$)/);
    expect(wire('block:project-billing').dataset.moving).toBeUndefined();
    expect(
      wire('block:project-billing')
        .querySelector('path')!
        .getAttribute('class'),
    ).not.toMatch(/(^|\s)transition-none(\s|$)/);

    press('pointerup', 160, 140);
  });

  it('keeps a two-finger pan that started on the graph moving the graph over an open card, and leaves a scroll that started on the card to the card', async () => {
    await draw({
      threads: graphThreadsOf(3),
      openCards: [openCard('thread-2')],
    });
    const pane = container.querySelector<HTMLElement>('.react-flow__pane')!;
    const cardBody = container.querySelector<HTMLElement>(
      '[data-slot="thread-canvas-card"][data-run-id="thread-2"]',
    )!;
    const wheel = (
      target: HTMLElement,
      at: number,
    ): { event: WheelEvent; prevented: boolean } => {
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaX: 12,
        deltaY: 8,
      });
      Object.defineProperty(event, 'timeStamp', { value: at });
      act(() => {
        target.dispatchEvent(event);
      });
      return { event, prevented: event.defaultPrevented };
    };

    wheel(pane, 1_000);
    seams.setViewport.splice(0);
    expect(wheel(cardBody, 1_050).prevented).toBe(true);
    expect(seams.setViewport).toHaveLength(1);

    seams.setViewport.splice(0);
    expect(wheel(cardBody, 2_000).prevented).toBe(false);
    expect(seams.setViewport).toEqual([]);
  });

  it('offers Reset zoom only once the view leaves the zoom it opened at, and takes it back there', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const resetZoom = () =>
      container.querySelector<HTMLButtonElement>(
        '[data-slot="graph-reset-zoom"]',
      );
    await draw({ threads: graphThreadsOf(3) });
    expect(resetZoom()).toBeNull();
    const opened = seams.setViewport.at(-1)![0] as { zoom: number };

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!
        .click(),
    );
    await settle();
    expect(resetZoom()).not.toBeNull();
    expect(resetZoom()!.textContent).toContain('Reset zoom');

    seams.setViewport.splice(0);
    act(() => resetZoom()!.click());
    await settle();
    expect(seams.setViewport.at(-1)![0]).toMatchObject({ zoom: opened.zoom });
    expect(resetZoom()).toBeNull();
  });

  it('keeps the view the viewer moved when the graph grows wider, rather than refitting over it', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    await draw({ threads: graphThreadsOf(3) });
    clock.mockReturnValue(60_000);
    act(() => seams.moveStart?.());
    seams.setViewport.splice(0);

    await draw({ threads: graphThreadsOf(12) });

    expect(seams.setViewport).toEqual([]);
  });

  it('refits a view the viewer moved when the canvas itself changes size', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const previous = globalThis.ResizeObserver;
    const canvasSizes: ((entries: ResizeObserverEntry[]) => void)[] = [];
    globalThis.ResizeObserver = class {
      private readonly callback: (entries: ResizeObserverEntry[]) => void;

      constructor(callback: (entries: ResizeObserverEntry[]) => void) {
        this.callback = callback;
      }

      observe(target: Element): void {
        if (target.parentElement?.dataset.slot === 'command-center-graph') {
          canvasSizes.push(this.callback);
        }
      }

      unobserve(): void {}

      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    try {
      await draw({ threads: graphThreadsOf(3) });
      clock.mockReturnValue(60_000);
      act(() => seams.moveStart?.());
      seams.setViewport.splice(0);

      act(() => {
        canvasSizes.at(-1)!([
          { contentRect: { width: 900, height: 600 } },
        ] as unknown as ResizeObserverEntry[]);
      });

      expect(seams.setViewport.length).toBeGreaterThan(0);
    } finally {
      globalThis.ResizeObserver = previous;
    }
  });

  it('lets the view pan far past the graph and keeps it there', async () => {
    await draw({ threads: graphThreadsOf(3) });

    act(() => {
      void seams.flowApi!.setViewport({ x: -90_000, y: 90_000, zoom: 1 });
    });
    await settle();

    expect(seams.flow).not.toHaveProperty('translateExtent');
    expect(seams.flowApi!.getViewport()).toEqual({
      x: -90_000,
      y: 90_000,
      zoom: 1,
    });
  });

  it('brings the whole graph back into view from far off with Fit', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await draw({ threads: graphThreadsOf(3) });
    act(() => {
      void seams.flowApi!.setViewport({ x: -90_000, y: 90_000, zoom: 1 });
    });
    await settle();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Fit the graph"]')!
        .click();
    });
    await settle();

    const view = seams.flowApi!.getViewport();
    const manager = nodeAt('graph-manager');
    expect(view.x).toBeGreaterThanOrEqual(0);
    expect(view.y).toBeGreaterThanOrEqual(0);
    expect(view.zoom).toBeLessThanOrEqual(1);
    expect(manager.x * view.zoom + view.x).toBeGreaterThanOrEqual(0);
  });
});

describe('graphBlocks', () => {
  it('sizes an open thread’s box as its card, and every other thread as its node', () => {
    const threads = graphThreadsOf(3);
    const size = { width: 500, height: 300 };
    const open = new Map<string, GraphOpenCard>([
      ['thread-2', openCard('thread-2', size)],
    ]);

    const items = graphBlocks(
      shownThreads(threads, open),
      FIXTURE_PROJECTS,
      open,
    ).flatMap((block) => block.items);

    expect(items.find((box) => box.id === 'thread:thread-2')).toEqual({
      id: 'thread:thread-2',
      ...cardBox(size),
    });
    expect(items.find((box) => box.id === 'thread:thread-1')).toEqual({
      id: 'thread:thread-1',
      width: THREAD_CARD_WIDTH,
      height: threadCardHeight(threads[0]!.view),
    });
  });

  it('gives one block per project in the order the projects stand, and the threads of no project a block last', () => {
    const blocks = graphBlocks(graphThreadsOf(7), FIXTURE_PROJECTS);

    expect(blocks.map((block) => block.id)).toEqual([
      'block:project-billing',
      'block:project-cache',
      NO_PROJECT_BLOCK,
    ]);
    expect(blocks.at(-1)!.name).toBe('No project');
    expect(blocks[0]!.name).toBe('QA Billing');
  });

  it('draws a project not in the list after the listed ones, and before the threads of no project', () => {
    const blocks = graphBlocks(graphThreadsOf(7), [FIXTURE_PROJECTS[1]!]);

    expect(blocks.map((block) => block.id)).toEqual([
      'block:project-cache',
      'block:project-billing',
      NO_PROJECT_BLOCK,
    ]);
  });

  it('stands working threads first in each block, then the rest in attention order', () => {
    for (const block of graphBlocks(
      shownThreads(graphThreadsOf(30)),
      FIXTURE_PROJECTS,
    )) {
      const ranks = block.threads.map((thread) =>
        BLOCK_ATTENTION_ORDER.indexOf(thread.view.attention),
      );
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
  });
  it('stands a block’s threads in the order the user set for it, and the other blocks in theirs', () => {
    const threads = graphThreadsOf(4);
    const shown = shownThreads(threads);
    const automatic = (id: string): string[] =>
      graphBlocks(shown, FIXTURE_PROJECTS)
        .find((block) => block.id === id)!
        .threads.map((thread) => thread.id);
    const billing = [...automatic('block:project-billing')].reverse();

    const blocks = graphBlocks(
      shown,
      FIXTURE_PROJECTS,
      new Map(),
      new Map(),
      threads,
      { 'block:project-billing': billing },
    );

    expect(
      blocks
        .find((block) => block.id === 'block:project-billing')!
        .threads.map((thread) => thread.id),
    ).toEqual(billing);
    expect(
      blocks
        .find((block) => block.id === 'block:project-cache')!
        .threads.map((thread) => thread.id),
    ).toEqual(automatic('block:project-cache'));
  });
});

type FlowNode = NonNullable<ReactFlowProps['nodes']>[number];

function nodesOfType(type: string): FlowNode[] {
  return (seams.flow?.nodes ?? []).filter((node) => node.type === type);
}

function flowNode(id: string): FlowNode {
  const node = (seams.flow?.nodes ?? []).find((step) => step.id === id);
  if (node === undefined) {
    throw new Error(`no flow node ${id}`);
  }
  return node;
}

function blockSize(id: string): { width: number; height: number } {
  const node = flowNode(id);
  return { width: node.width ?? 0, height: node.height ?? 0 };
}

function openCard(
  runId: string,
  size: { width: number; height: number } = { width: 460, height: 420 },
): GraphOpenCard {
  return {
    runId,
    band: { attention: 'working', lastAt: new Date(FIXTURE_NOW).toISOString() },
    size,
  };
}
