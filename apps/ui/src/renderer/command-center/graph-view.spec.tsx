// @vitest-environment jsdom
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
import { type GraphThread, GraphView, MAX_THREAD_NODES } from './graph-view';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-17T12:00:00Z');
const MINUTE = 60_000;
const MANAGER = { id: 'manager-run', label: 'Manager' };

function threadsOf(count: number): GraphThread[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `thread-${index + 1}`,
    label: `Thread ${index + 1}`,
    status: 'working',
  }));
}

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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function draw(
    overrides: Partial<React.ComponentProps<typeof GraphView>> = {},
  ): void {
    act(() => {
      root.render(
        <GraphView
          manager={MANAGER}
          threads={[]}
          contacts={{}}
          pulses={[]}
          now={NOW}
          onOpen={() => undefined}
          {...overrides}
        />,
      );
    });
  }

  function threadNodes(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="graph-thread"]'),
    );
  }

  function threadNode(threadId: string): HTMLElement {
    const node = container.querySelector<HTMLElement>(
      `[data-slot="graph-thread"][data-thread-id="${threadId}"]`,
    );
    if (node === null) {
      throw new Error(`no thread node for ${threadId}`);
    }
    return node;
  }

  it('draws at most 24 thread nodes and one "+N more" node for the rest', () => {
    draw({ threads: threadsOf(30) });
    expect(threadNodes()).toHaveLength(MAX_THREAD_NODES);
    expect(
      container.querySelector('[data-slot="graph-more"]')?.textContent,
    ).toBe('+6 more');
  });

  it('draws no "+N more" node while the threads fit under the cap', () => {
    draw({ threads: threadsOf(MAX_THREAD_NODES) });
    expect(threadNodes()).toHaveLength(MAX_THREAD_NODES);
    expect(container.querySelector('[data-slot="graph-more"]')).toBeNull();
  });

  it('shows the empty line instead of a graph when there is no manager', () => {
    draw({ manager: null, threads: threadsOf(2) });
    expect(
      container.querySelector('[data-slot="command-center-graph-empty"]'),
    ).not.toBeNull();
    expect(container.querySelector('.react-flow')).toBeNull();
    expect(threadNodes()).toHaveLength(0);
  });

  it('opens the thread when Enter is pressed on its node', () => {
    const onOpen = vi.fn();
    draw({ threads: threadsOf(3), onOpen });
    act(() => {
      threadNode('thread-2').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('thread-2');
  });

  it('opens the thread on a click of its node', () => {
    const onOpen = vi.fn();
    draw({ threads: threadsOf(2), onOpen });
    act(() => {
      threadNode('thread-1').click();
    });
    expect(onOpen).toHaveBeenCalledWith('thread-1');
  });

  it('names the focused node and its contact state in the details line', () => {
    const contacts: Record<string, ContactState> = {
      'thread-2': {
        lastAt: new Date(NOW - 40 * MINUTE).toISOString(),
        awaitingReply: true,
      },
    };
    const threads: GraphThread[] = [
      { id: 'thread-1', label: 'Thread 1', status: 'idle' },
      { id: 'thread-2', label: 'Thread 2', status: 'waiting' },
    ];
    draw({ threads, contacts });
    const details = container.querySelector(
      '[data-slot="command-center-graph-details"]',
    );
    expect(details?.getAttribute('aria-live')).toBe('polite');
    expect(details?.textContent).toMatch(/^Focus a thread/);

    act(() => {
      threadNode('thread-2').focus();
    });
    expect(details?.textContent).toBe(
      'Thread 2, waiting, awaiting a reply, last contact 40 min ago',
    );
    expect(threadNode('thread-2').dataset.contact).toBe('awaiting');
    expect(threadNode('thread-1').dataset.contact).toBe('idle');
  });

  it('marks a thread contacted within five minutes as lit', () => {
    draw({
      threads: threadsOf(2),
      contacts: {
        'thread-1': {
          lastAt: new Date(NOW - 2 * MINUTE).toISOString(),
          awaitingReply: false,
        },
      },
      pulses: [
        {
          id: 'p',
          threadId: 'thread-2',
          at: new Date(NOW).toISOString(),
          direction: 'out',
        },
      ],
    });
    expect(threadNode('thread-1').dataset.contact).toBe('lit');
    expect(threadNode('thread-2').dataset.contact).toBe('lit');
  });

  it('keeps every edge drawn when a reply rebuilds the nodes, its state moving from awaiting to lit', () => {
    const edges = (): HTMLElement[] =>
      Array.from(
        container.querySelectorAll<HTMLElement>('[data-slot="contact-edge"]'),
      );
    const threads = threadsOf(3);
    const sentAt = new Date(NOW - MINUTE).toISOString();
    draw({
      threads,
      contacts: { 'thread-1': { lastAt: sentAt, awaitingReply: true } },
    });
    expect(edges()).toHaveLength(3);
    expect(
      container
        .querySelector('[data-edge="contact:thread-1"]')
        ?.getAttribute('data-state'),
    ).toBe('awaiting');

    draw({
      threads: threads.map((thread) => ({ ...thread })),
      contacts: {
        'thread-1': {
          lastAt: new Date(NOW).toISOString(),
          awaitingReply: false,
        },
      },
    });

    expect(edges()).toHaveLength(3);
    expect(
      container
        .querySelector('[data-edge="contact:thread-1"]')
        ?.getAttribute('data-state'),
    ).toBe('lit');
  });
});
