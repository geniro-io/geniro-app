// @vitest-environment jsdom
import type { ReactFlowProps } from '@xyflow/react';
import { act } from 'react';
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
import type { ContactState } from './contact-edge';
import {
  FIXTURE_NOW,
  FIXTURE_PROJECTS,
  graphThreadsOf,
} from './graph-fixtures';
import type { GraphOpenCard, GraphThread } from './graph-view';
import {
  cardBox,
  graphRows,
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
}));

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
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
      await new Promise((resolve) => setTimeout(resolve, 5));
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
          onResetLayout={() => undefined}
          onFocused={() => undefined}
          renderCardChat={() => null}
          focus={null}
          projects={[]}
          asking={new Map()}
          onAnswer={() => undefined}
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

  it('heads the tree with the manager and hangs every thread under it as a card, wires going down', async () => {
    await draw({ threads: graphThreadsOf(4) });

    expect(all('graph-manager')).toHaveLength(1);
    expect(all('graph-thread')).toHaveLength(4);
    expect(all('contact-edge')).toHaveLength(4);
    const managerY = nodeY('graph-manager');
    for (const id of ['thread-1', 'thread-2', 'thread-3', 'thread-4']) {
      expect(nodeY('graph-thread', id)).toBeGreaterThan(managerY);
    }
  });

  it('stands the threads in bands by attention: blocked on top, then questions, working, quiet, inactive last', async () => {
    const threads = graphThreadsOf(10);
    await draw({ threads });

    const graph = all('command-center-graph')[0]!;
    expect(graph.dataset.layout).toBe('bands');
    const order = [
      'blocked',
      'question',
      'working',
      'quiet',
      'inactive',
    ] as const;
    const bandY = (attention: (typeof order)[number]): number[] =>
      threads
        .filter((thread) => thread.view.attention === attention)
        .map((thread) => nodeY('graph-thread', thread.id));
    for (let band = 1; band < order.length; band += 1) {
      expect(Math.min(...bandY(order[band]!))).toBeGreaterThan(
        Math.max(...bandY(order[band - 1]!)),
      );
    }
  });

  it('sizes each card to what it shows, with no padding to a common height', async () => {
    await draw({ threads: graphThreadsOf(6) });

    expect(
      new Set(all('thread-card').map((card) => card.style.height)).size,
    ).toBeGreaterThan(1);
  });

  it('keys the colours in a legend, with how many threads stand in each band', async () => {
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

  it('draws at most 24 thread cards and one "+N more" node for the rest', async () => {
    await draw({ threads: graphThreadsOf(30) });

    expect(all('graph-thread')).toHaveLength(MAX_THREAD_NODES);
    expect(all('graph-more')[0]?.textContent).toBe('+6 more threads');
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

  it('keys each project on the graph to its colour in a corner legend, and marks each card with its project’s dot', async () => {
    await draw({ threads: graphThreadsOf(3), projects: FIXTURE_PROJECTS });

    const legend = all('graph-project').map((entry) => [
      entry.textContent,
      entry.dataset.color,
    ]);
    expect(legend).toEqual([
      ['QA Billing', 'blue'],
      ['QA Cache', 'purple'],
    ]);
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
  });

  it('draws no project legend when no thread on the graph has a project', async () => {
    await draw({ threads: graphThreadsOf(2), projects: [] });

    expect(all('graph-projects')).toHaveLength(0);
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

  it('names each card’s contact state for a screen reader, and paints its wire to match', async () => {
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
    expect(state('thread-1')).toBe('lit');
    expect(state('thread-2')).toBe('awaiting');
    expect(state('thread-3')).toBe('idle');
  });

  it('keeps every wire drawn when a reply rebuilds the cards, its state moving from awaiting to lit', async () => {
    const threads = graphThreadsOf(3);
    const sentAt = new Date(FIXTURE_NOW - MINUTE).toISOString();
    await draw({
      threads,
      contacts: { 'thread-1': { lastAt: sentAt, awaitingReply: true } },
    });
    expect(all('contact-edge')).toHaveLength(3);

    await draw({
      threads: threads.map((thread) => ({ ...thread })),
      contacts: {
        'thread-1': {
          lastAt: new Date(FIXTURE_NOW).toISOString(),
          awaitingReply: false,
        },
      },
    });

    expect(all('contact-edge')).toHaveLength(3);
    expect(
      container
        .querySelector('[data-edge="contact:thread-1"]')
        ?.getAttribute('data-state'),
    ).toBe('lit');
  });

  it('lets the pointer reach every node, so a card answers the mouse', async () => {
    await draw({ threads: graphThreadsOf(2) });

    const wrappers = Array.from(
      container.querySelectorAll<HTMLElement>('.react-flow__node'),
    );
    expect(wrappers.length).toBeGreaterThan(0);
    for (const wrapper of wrappers) {
      expect(wrapper.style.pointerEvents).toBe('all');
    }
  });

  it('lays a phone out as one column it scrolls, every card under the manager in attention order', async () => {
    const threads = graphThreadsOf(4);
    await draw({ threads, narrow: true });

    const graph = all('command-center-graph')[0]!;
    expect(graph.dataset.layout).toBe('column');
    const ys = shownThreads(threads).map((thread) =>
      nodeY('graph-thread', thread.id),
    );
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys[0]).toBeGreaterThan(nodeY('graph-manager'));
    expect(all('contact-edge')).toHaveLength(4);
  });

  it('puts the phone column’s flow pane under cc-touch-scroll, so a finger swipe scrolls the page rather than being eaten by the pane', async () => {
    await draw({ threads: graphThreadsOf(4), narrow: true });

    const pane = container.querySelector('.react-flow__pane')!;
    expect(pane.closest('.cc-touch-scroll')).not.toBeNull();
  });

  it('leaves the desktop canvas’s pane to React Flow, which pans it by drag', async () => {
    await draw({ threads: graphThreadsOf(4), narrow: false });

    const pane = container.querySelector('.react-flow__pane')!;
    expect(pane.closest('.cc-touch-scroll')).toBeNull();
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
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.draggable).toBe(false);
    }
    expect(seams.flow?.nodeDragThreshold).toBe(5);
  });

  it('lets no node be dragged on a phone, where the column is the layout', async () => {
    await draw({ threads: graphThreadsOf(3), narrow: true });

    const nodes = seams.flow?.nodes ?? [];
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.every((node) => node.draggable === false)).toBe(true);
  });

  it('moves a dragged thread node with the pointer, and on release places it at the drop, relative to the manager', async () => {
    const onPlaceNode = vi.fn();
    await draw({ threads: graphThreadsOf(3), onPlaceNode });
    const start = flowNode('thread:thread-2').position;
    const to = { x: start.x + 120, y: start.y + 40 };

    act(() => {
      seams.flow!.onNodesChange!([
        {
          type: 'position',
          id: 'thread:thread-2',
          position: to,
          dragging: true,
        },
      ]);
    });
    const during = nodeAt('graph-thread', 'thread-2');
    expect(during.x).toBeCloseTo(to.x, 5);
    expect(during.y).toBeCloseTo(to.y, 5);
    expect(onPlaceNode).not.toHaveBeenCalled();

    act(() => {
      seams.flow!.onNodeDragStop!(
        new MouseEvent('mouseup'),
        flowNode('thread:thread-2'),
        [],
      );
    });
    const manager = nodesOfType('manager')[0]!.position;
    expect(onPlaceNode).toHaveBeenCalledTimes(1);
    expect(onPlaceNode).toHaveBeenCalledWith('thread-2', {
      x: to.x - manager.x,
      y: to.y - manager.y,
    });
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

  it('moves an open card’s slot with its head, and on the drop places it relative to the manager', async () => {
    Element.prototype.setPointerCapture = vi.fn();
    const onPlaceNode = vi.fn();
    await draw({
      threads: graphThreadsOf(3),
      openCards: [openCard('thread-2')],
      onPlaceNode,
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
    press('pointermove', 160, 140);
    const during = nodeAt('graph-slot', 'thread-2');
    expect(during.x).toBeCloseTo(start.x + 60, 5);
    expect(during.y).toBeCloseTo(start.y + 40, 5);
    expect(onPlaceNode).not.toHaveBeenCalled();

    press('pointerup', 160, 140);
    const manager = nodeAt('graph-manager');
    expect(onPlaceNode).toHaveBeenCalledWith('thread-2', {
      x: start.x + 60 - manager.x,
      y: start.y + 40 - manager.y,
    });
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
});

describe('graphRows', () => {
  it('sizes an open thread’s box as its card, and every other thread as its node', () => {
    const threads = graphThreadsOf(3);
    const size = { width: 500, height: 300 };
    const open = new Map<string, GraphOpenCard>([
      ['thread-2', openCard('thread-2', size)],
    ]);

    const boxes = graphRows(shownThreads(threads, open), 0, 0, open).flat();

    expect(boxes.find((box) => box.id === 'thread:thread-2')).toEqual({
      id: 'thread:thread-2',
      ...cardBox(size),
    });
    expect(boxes.find((box) => box.id === 'thread:thread-1')).toEqual({
      id: 'thread:thread-1',
      width: THREAD_CARD_WIDTH,
      height: threadCardHeight(threads[0]!.view),
    });
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
