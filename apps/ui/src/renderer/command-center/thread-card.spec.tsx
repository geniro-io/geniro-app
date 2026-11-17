// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ThreadCard,
  threadCardHeight,
  type ThreadCardProps,
  type ThreadCardStatus,
} from './thread-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function props(over: Partial<ThreadCardProps> = {}): ThreadCardProps {
  return {
    title: 'Fix the login redirect',
    status: 'working',
    handle: null,
    project: 'Geniro',
    agentLabel: 'Claude',
    pullRequest: null,
    note: null,
    activity: null,
    boardCard: null,
    idleDays: null,
    onGo: vi.fn(),
    ...over,
  };
}

function render(over: Partial<ThreadCardProps> = {}): HTMLElement {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<ThreadCard {...props(over)} />);
  });
  return container.querySelector<HTMLElement>('[data-slot="thread-card"]')!;
}

describe('ThreadCard — going to the thread', () => {
  it('opens nothing when the card itself is clicked', () => {
    const onGo = vi.fn();
    const el = render({ onGo });

    act(() => {
      el.click();
    });

    expect(onGo).not.toHaveBeenCalled();
    expect(el.getAttribute('role')).toBeNull();
  });

  it('goes to the thread from its Go to thread button', () => {
    const onGo = vi.fn();
    const button = render({ onGo }).querySelector<HTMLButtonElement>(
      '[data-slot="thread-card-go"]',
    )!;

    expect(button.textContent).toContain('Go to thread');
    act(() => {
      button.click();
    });

    expect(onGo).toHaveBeenCalledTimes(1);
  });
});

describe('ThreadCard — content', () => {
  it.each<[ThreadCardStatus, string]>([
    ['working', 'Working'],
    ['waiting', 'Waiting on you'],
    ['idle', 'Idle'],
    ['failed', 'Failed'],
    ['done', 'Done'],
  ])('names the %s status in words', (status, text) => {
    const el = render({ status });

    const line = el.querySelector<HTMLElement>(
      '[data-slot="thread-card-status"]',
    )!;
    expect(line.textContent).toContain(text);
    expect(el.dataset.status).toBe(status);
  });

  it('pulses its dot only while the thread works', () => {
    expect(
      render({ status: 'working' }).querySelector(
        '[data-slot="thread-card-dot-ping"]',
      ),
    ).not.toBeNull();
    expect(
      render({ status: 'idle' }).querySelector(
        '[data-slot="thread-card-dot-ping"]',
      ),
    ).toBeNull();
  });

  it('keeps a long title on one line, whole in its tooltip', () => {
    const long = 'A long thread title '.repeat(12).trim();
    const el = render({ title: long });

    const title = el.querySelector<HTMLElement>(
      '[data-slot="thread-card-title"]',
    )!;
    expect(title.classList.contains('truncate')).toBe(true);
    expect(title.title).toBe(long);
  });

  it('is exactly as tall as the graph laid it out for what it shows', () => {
    const el = render({
      note: 'watch billing',
      activity: 'running tests',
      idleDays: 4,
    });

    expect(el.style.height).toBe(
      `${threadCardHeight({ labels: true, note: true, activity: true })}px`,
    );
    expect(
      threadCardHeight({ labels: false, note: false, activity: false }),
    ).toBeLessThan(
      threadCardHeight({ labels: true, note: true, activity: true }),
    );
  });

  it('draws the manager note when there is one, and nothing when there is not', () => {
    const withNote = render({ note: 'Waiting for the CI run' });
    expect(
      withNote.querySelector('[data-slot="thread-card-note"]')!.textContent,
    ).toBe('Waiting for the CI run');

    const without = render({ note: null });
    expect(without.querySelector('[data-slot="thread-card-note"]')).toBeNull();
  });

  it('shows the pull request with its number and state word', () => {
    const el = render({ pullRequest: { number: 412, state: 'merged' } });

    const chip = el.querySelector<HTMLElement>(
      '[data-slot="thread-card-pull-request"]',
    )!;
    expect(chip.textContent).toContain('412');
    expect(chip.textContent).toContain('merged');
  });

  it('draws no pull request chip when the thread has none', () => {
    const el = render({ pullRequest: null });

    expect(
      el.querySelector('[data-slot="thread-card-pull-request"]'),
    ).toBeNull();
  });

  it('puts the status, handle, project and agent on one line', () => {
    const el = render({
      status: 'idle',
      handle: 't3',
      project: 'Geniro',
      agentLabel: 'Claude',
    });

    expect(
      el.querySelector('[data-slot="thread-card-status"]')!.textContent,
    ).toBe('Idle · t3 · Geniro · Claude');
  });

  it('says what the thread is doing now, when it is doing anything', () => {
    expect(
      render({ activity: 'running the test suite' }).querySelector(
        '[data-slot="thread-card-activity"]',
      )!.textContent,
    ).toBe('Now: running the test suite');
    expect(
      render({ activity: null }).querySelector(
        '[data-slot="thread-card-activity"]',
      ),
    ).toBeNull();
  });

  it('says it as plain text, with no markdown markers', () => {
    const line = render({
      activity: '**Rebased** on `main` — see [the PR](https://x.test/1)',
    }).querySelector('[data-slot="thread-card-activity"]')!;

    expect(line.textContent).toBe('Now: Rebased on main — see the PR');
  });

  it('drops a backtick a cut-off code span left open', () => {
    const line = render({
      activity: 'Told `8bbdf9e6-0a39-4d4d-a…',
    }).querySelector('[data-slot="thread-card-activity"]')!;

    expect(line.textContent).toBe('Now: Told 8bbdf9e6-0a39-4d4d-a…');
  });

  it('stands as tall as its row asks, but never shorter than its content', () => {
    const own = threadCardHeight({
      labels: false,
      note: false,
      activity: false,
    });

    expect(render({ height: own + 40 }).style.height).toBe(`${own + 40}px`);
    expect(render({ height: own - 40 }).style.height).toBe(`${own}px`);
  });

  it('draws no timeline strip', () => {
    expect(render().querySelector('[data-slot="timeline-strip"]')).toBeNull();
  });
});

describe('ThreadCard — labels', () => {
  it('shows the board card it works as a label, and none for a thread without one', () => {
    const label = render({
      boardCard: {
        identifier: 'GEN-412',
        title: 'Fix login',
        status: 'in_progress',
      },
    }).querySelector('[data-slot="thread-card-board-card"]')!;

    expect(label.textContent).toBe('GEN-412· In progress');
    expect(
      render({ boardCard: null }).querySelector(
        '[data-slot="thread-card-board-card"]',
      ),
    ).toBeNull();
  });

  it('marks a thread nobody touched for days with how many, and only such a thread', () => {
    expect(
      render({ idleDays: 6 }).querySelector('[data-slot="thread-card-idle"]')!
        .textContent,
    ).toBe('Idle 6 days');
    expect(
      render({ idleDays: null }).querySelector(
        '[data-slot="thread-card-idle"]',
      ),
    ).toBeNull();
  });
});
