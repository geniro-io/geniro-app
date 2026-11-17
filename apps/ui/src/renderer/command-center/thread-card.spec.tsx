// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ThreadCard,
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

const STRIP: ThreadCardProps['strip'] = {
  start: '2026-11-17T10:00:00.000Z',
  end: '2026-11-17T14:00:00.000Z',
  spans: [{ kind: 'work', start: '2026-11-17T11:00:00.000Z', end: null }],
  markers: [
    { kind: 'user_message', at: '2026-11-17T11:00:00.000Z', label: 'Start' },
  ],
};

function props(over: Partial<ThreadCardProps> = {}): ThreadCardProps {
  return {
    title: 'Fix the login redirect',
    status: 'working',
    project: 'Geniro',
    agentLabel: 'Claude',
    pullRequest: null,
    note: null,
    activity: null,
    strip: STRIP,
    onOpen: vi.fn(),
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

const press = (el: HTMLElement, key: string): void => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

describe('ThreadCard — opening', () => {
  it('opens the thread on click', () => {
    const onOpen = vi.fn();
    const el = render({ onOpen });

    act(() => {
      el.click();
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens the thread on Enter and on Space', () => {
    const onOpen = vi.fn();
    const el = render({ onOpen });

    press(el, 'Enter');
    press(el, ' ');

    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('ignores other keys', () => {
    const onOpen = vi.fn();
    const el = render({ onOpen });

    press(el, 'a');
    press(el, 'Tab');

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('is a focusable button-like element', () => {
    const el = render();

    expect(el.getAttribute('role')).toBe('button');
    expect(el.tabIndex).toBe(0);
  });

  it('answers a press on a marker in its strip without opening the thread', () => {
    const onOpen = vi.fn();
    const onMarker = vi.fn();
    const el = render({ onOpen, strip: { ...STRIP, onMarker } });

    const marker = el.querySelector<HTMLButtonElement>(
      '[data-slot="timeline-marker"]',
    )!;
    act(() => {
      marker.click();
    });
    press(marker, 'Enter');

    expect(onMarker).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
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
    expect(line.querySelector('[data-status]')).not.toBeNull();
  });

  it('clamps the title to two lines', () => {
    const el = render({ title: 'A long thread title '.repeat(12) });

    const title = el.querySelector<HTMLElement>(
      '[data-slot="thread-card-title"]',
    )!;
    expect(title.classList.contains('line-clamp-2')).toBe(true);
    expect(title.textContent).toContain('A long thread title');
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

  it('puts the project and the agent on one line', () => {
    const el = render({ project: 'Geniro', agentLabel: 'Claude' });

    expect(el.textContent).toContain('Geniro · Claude');
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

  it('draws the timeline strip', () => {
    const el = render();

    expect(el.querySelector('[data-slot="timeline-strip"]')).not.toBeNull();
  });
});
