// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bareThreadIdentity,
  type ThreadIdentity,
} from '../components/thread-head';
import {
  WORKING_THREADS_CEILING,
  type WorkingThread,
  WorkingThreadsCard,
} from './working-threads-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const AGENT: ThreadIdentity = {
  ...bareThreadIdentity('Export the CSV'),
  face: { kind: 'agent', icon: 'terminal', name: 'claude' },
  status: { attention: 'working', text: 'Working' },
  agentLabel: 'claude',
};

function thread(
  over: Partial<Omit<WorkingThread, 'identity'>> & {
    identity?: Partial<ThreadIdentity>;
  },
): WorkingThread {
  return {
    runId: 'run-1',
    status: 'working',
    lastMessage: null,
    lastAt: '2026-11-19T08:00:00Z',
    background: { held: false, subagents: 0, commands: 0 },
    ...over,
    identity: { ...AGENT, ...over.identity },
  };
}

function render(
  threads: readonly WorkingThread[],
  options: {
    beside?: boolean;
    onOpenThread?: (runId: string) => void;
    onOpenHere?: (runId: string) => void;
  } = {},
): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <WorkingThreadsCard
        threads={threads}
        beside={options.beside ?? false}
        onOpenThread={options.onOpenThread}
        onOpenHere={options.onOpenHere}
      />,
    );
  });
  return container;
}

const slot = (el: Element, name: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`[data-slot="${name}"]`);

const rowsOf = (el: Element): HTMLElement[] =>
  Array.from(
    el.querySelectorAll<HTMLElement>('[data-slot="working-thread-row"]'),
  );

async function openPanel(el: Element): Promise<void> {
  await act(async () => {
    slot(el, 'working-threads-toggle')!
      .querySelector('button')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function press(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('WorkingThreadsCard', () => {
  it('draws nothing with no thread to list', () => {
    const el = render([]);

    expect(slot(el, 'working-threads-card')).toBeNull();
  });

  it('counts the working threads and the ones waiting on the user', () => {
    const el = render([
      thread({ runId: 'a' }),
      thread({ runId: 'b' }),
      thread({ runId: 'c', status: 'waiting' }),
    ]);

    expect(slot(el, 'working-threads-count')!.textContent).toBe(
      '2 working · 1 waiting on you',
    );
  });

  it('leaves out the waiting count when nobody waits', () => {
    const el = render([thread({ runId: 'a' }), thread({ runId: 'b' })]);

    expect(slot(el, 'working-threads-count')!.textContent).toBe('2 working');
  });

  it('leaves out the working count when every thread waits', () => {
    const el = render([thread({ status: 'waiting' })]);

    expect(slot(el, 'working-threads-count')!.textContent).toBe(
      '1 waiting on you',
    );
  });

  it('sits in the corner alone', () => {
    const el = render([thread({})]);

    const card = slot(el, 'working-threads-card')!;
    expect(card.className).toContain('right-4');
    expect(card.className).toContain('-bottom-2');
  });

  it('sits left of the agents card beside it', () => {
    const el = render([thread({})], { beside: true });

    const card = slot(el, 'working-threads-card')!;
    expect(card.className).toContain('right-14');
    expect(card.className).not.toContain('right-4');
  });

  it('lists the threads waiting on the user first, then the working ones, each group under its name and count', async () => {
    const el = render([
      thread({ runId: 'a' }),
      thread({ runId: 'b', status: 'waiting' }),
      thread({ runId: 'c' }),
    ]);

    await openPanel(el);

    const groups = Array.from(
      el.querySelectorAll<HTMLElement>('[data-slot="working-threads-group"]'),
    );
    expect(groups.map((group) => group.dataset.status)).toEqual([
      'waiting',
      'working',
    ]);
    expect(groups[0]!.querySelector('h3')!.textContent).toBe('Waiting on you1');
    expect(groups[1]!.querySelector('h3')!.textContent).toBe('Working2');
    expect(rowsOf(el).map((row) => row.dataset.run)).toEqual(['b', 'a', 'c']);
  });

  it('heads each row as the thread’s node on the graph: face, title, pull request, status, agent, board card and project in colour', async () => {
    const el = render([
      thread({
        runId: 'a',
        identity: {
          title: 'Export the CSV',
          pullRequest: { number: 146, state: 'open' },
          boardCard: { identifier: 'PRI-10', title: 'Export', status: 'todo' },
          project: 'Geniro',
          projectColor: 'teal',
        },
      }),
    ]);

    await openPanel(el);

    const row = rowsOf(el)[0]!;
    expect(slot(row, 'working-thread-face')!.dataset.face).toBe('agent');
    expect(slot(row, 'working-thread-title')!.textContent).toBe(
      'Export the CSV',
    );
    expect(slot(row, 'working-thread-pull-request')!.textContent).toContain(
      `#${146}`,
    );
    expect(slot(row, 'working-thread-status')!.textContent).toBe('Working');
    expect(slot(row, 'working-thread-agent')!.textContent).toBe('claude');
    expect(slot(row, 'working-thread-board-card')!.textContent).toBe('PRI-10');
    expect(slot(row, 'working-thread-project')!.textContent).toBe('Geniro');
    expect(
      slot(row, 'working-thread-project-dot')!.getAttribute('data-color'),
    ).toBe('teal');
    expect(slot(row, 'working-thread-time')!.title).not.toBe('');
  });

  it('shows a team thread by its crew’s faces', async () => {
    const el = render([
      thread({
        runId: 'a',
        identity: {
          face: {
            kind: 'team',
            people: [
              { key: 'senior', name: 'Tony Stark', avatar: null },
              { key: 'middle', name: 'Peter Parker', avatar: null },
            ],
            total: 4,
          },
          agentLabel: 'dev-team',
          isTeam: true,
        },
      }),
    ]);

    await openPanel(el);

    const face = slot(rowsOf(el)[0]!, 'working-thread-face')!;
    expect(face.dataset.face).toBe('team');
    expect(face.getAttribute('aria-label')).toBe('4 members');
  });

  it('names the work a thread still has out after its turn, and says nothing when it has none', async () => {
    const el = render([
      thread({
        runId: 'a',
        background: { held: true, subagents: 2, commands: 1 },
      }),
      thread({ runId: 'b' }),
    ]);

    await openPanel(el);

    const [busy, plain] = rowsOf(el);
    expect(slot(busy!, 'working-thread-held')).not.toBeNull();
    expect(slot(busy!, 'working-thread-subagents')!.textContent).toBe(
      '2 sub-agents',
    );
    expect(slot(busy!, 'working-thread-commands')!.textContent).toBe(
      '1 command',
    );
    expect(slot(plain!, 'working-thread-background')).toBeNull();
  });

  it('draws the latest message on a rail, and no rail without one', async () => {
    const el = render([
      thread({
        runId: 'a',
        lastMessage: 'Rebased on **main**, two specs left',
      }),
      thread({ runId: 'b', lastMessage: null }),
    ]);

    await openPanel(el);

    const [withMessage, without] = rowsOf(el);
    expect(slot(withMessage!, 'working-thread-message')!.textContent).toBe(
      'Rebased on main, two specs left',
    );
    expect(slot(withMessage!, 'working-thread-rail')).not.toBeNull();
    expect(slot(without!, 'working-thread-rail')).toBeNull();
  });

  it('a press on the row opens that thread by its run', async () => {
    const onOpenThread = vi.fn();
    const el = render([thread({ runId: 'a' }), thread({ runId: 'b' })], {
      onOpenThread,
    });
    await openPanel(el);

    await press(rowsOf(el)[1]!);

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith('b');
  });

  it('a press on the title opens the thread once, not once more from the row', async () => {
    const onOpenThread = vi.fn();
    const el = render([thread({ runId: 'a' })], { onOpenThread });
    await openPanel(el);

    await press(slot(rowsOf(el)[0]!, 'working-thread-title')!);

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith('a');
  });

  it('opens a thread in a window over the graph from its row, without opening it in Chats', async () => {
    const onOpenThread = vi.fn();
    const onOpenHere = vi.fn();
    const el = render([thread({ runId: 'a' })], { onOpenThread, onOpenHere });
    await openPanel(el);

    await press(slot(rowsOf(el)[0]!, 'working-thread-open-here')!);

    expect(onOpenHere).toHaveBeenCalledWith('a');
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('offers no window where the graph cannot hold one', async () => {
    const el = render([thread({})], { onOpenThread: () => {} });
    await openPanel(el);

    expect(slot(rowsOf(el)[0]!, 'working-thread-open-here')).toBeNull();
  });

  it('keeps no Go to thread button in the row', async () => {
    const el = render([thread({})], { onOpenThread: () => {} });
    await openPanel(el);

    expect(rowsOf(el)[0]!.textContent).not.toContain('Go to thread');
  });

  it('a row with no way to open its thread is not pressable', async () => {
    const el = render([thread({})]);
    await openPanel(el);

    const row = rowsOf(el)[0]!;
    expect(slot(row, 'working-thread-title')!.tagName).toBe('SPAN');
    expect(row.className).not.toContain('cursor-pointer');
  });

  it('never lets the list rise past the top of the page body', async () => {
    const tops = new Map<Element, number>();
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return { top: tops.get(this) ?? 0 } as DOMRect;
      });
    try {
      container = document.createElement('div');
      container.setAttribute(WORKING_THREADS_CEILING, '');
      document.body.append(container);
      root = createRoot(container);
      act(() => {
        root.render(
          <WorkingThreadsCard threads={[thread({})]} beside={false} />,
        );
      });
      tops.set(container, 100);
      tops.set(slot(container, 'working-threads-card')!, 500);

      await openPanel(container);

      expect(slot(container, 'working-threads-list')!.style.maxHeight).toBe(
        `${500 - 100 - 44 - 8}px`,
      );
    } finally {
      rect.mockRestore();
    }
  });
});
