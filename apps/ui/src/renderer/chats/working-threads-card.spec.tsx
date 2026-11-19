// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type WorkingThread, WorkingThreadsCard } from './working-threads-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function thread(over: Partial<WorkingThread>): WorkingThread {
  return {
    runId: 'run-1',
    title: 'Export the CSV',
    agentLabel: 'Senior Engineer',
    agentKind: 'claude',
    crew: null,
    project: null,
    projectColor: null,
    lastMessage: null,
    status: 'working',
    ...over,
  };
}

function render(
  threads: readonly WorkingThread[],
  options: { beside?: boolean; onOpenThread?: (runId: string) => void } = {},
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

  it('lays each thread out like a current run of the agents card: its title, its state, its agent and its project in colour', async () => {
    const el = render([
      thread({
        runId: 'a',
        title: 'Export the CSV',
        project: 'Geniro',
        projectColor: 'teal',
      }),
      thread({
        runId: 'b',
        title: 'Fix the parser',
        agentLabel: null,
        agentKind: 'codex',
        status: 'waiting',
      }),
    ]);

    await openPanel(el);

    const [first, second] = rowsOf(el);
    expect(rowsOf(el).map((row) => row.dataset.run)).toEqual(['a', 'b']);
    expect(slot(first!, 'working-thread-title')!.textContent).toBe(
      'Export the CSV',
    );
    expect(slot(first!, 'working-thread-state')!.textContent).toBe('working');
    expect(slot(first!, 'working-thread-agent')!.textContent).toBe(
      'Senior Engineer',
    );
    expect(slot(first!, 'working-thread-project')!.textContent).toBe('Geniro');
    expect(
      slot(first!, 'working-thread-project-dot')!.getAttribute('data-color'),
    ).toBe('teal');
    expect(slot(second!, 'working-thread-title')!.textContent).toBe(
      'Fix the parser',
    );
    expect(slot(second!, 'working-thread-state')!.textContent).toBe(
      'waiting on you',
    );
    expect(slot(second!, 'working-thread-agent')).toBeNull();
    expect(slot(second!, 'working-thread-project')).toBeNull();
  });

  it('shows a team thread as its crew faces in place of one agent face', async () => {
    const el = render([
      thread({
        runId: 'a',
        agentLabel: 'dev-team',
        agentKind: null,
        crew: {
          people: [
            { key: 'senior', name: 'Tony Stark', avatar: null },
            { key: 'middle', name: 'Peter Parker', avatar: null },
          ],
          total: 4,
        },
      }),
      thread({ runId: 'b' }),
    ]);

    await openPanel(el);

    const [team, agent] = rowsOf(el);
    expect(slot(team!, 'working-thread-crew')!.getAttribute('aria-label')).toBe(
      '4 members',
    );
    expect(slot(agent!, 'working-thread-crew')).toBeNull();
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

  it('shows a working thread with a primary pulse and a waiting one in the warning tone', async () => {
    const el = render([
      thread({ runId: 'a' }),
      thread({ runId: 'b', status: 'waiting' }),
    ]);

    await openPanel(el);

    const [working, waiting] = rowsOf(el);
    expect(slot(working!, 'working-thread-dot')!.dataset.status).toBe(
      'working',
    );
    expect(slot(waiting!, 'working-thread-dot')!.dataset.status).toBe(
      'waiting',
    );
    expect(
      slot(waiting!, 'working-thread-dot')!
        .querySelector('[data-slot="status-dot"]')!
        .getAttribute('data-tone'),
    ).toBe('warn');
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

    await press(slot(rowsOf(el)[0]!, 'working-thread-open')!);

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith('a');
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
    expect(slot(row, 'working-thread-open')).toBeNull();
    expect(row.className).not.toContain('cursor-pointer');
  });
});
