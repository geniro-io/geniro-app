// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatElapsed,
  liveRowKind,
  ThinkingRow,
  WorkingRow,
} from './live-row';

const roots: Root[] = [];

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(node);
  });
  return container;
}

/** Unmount everything this test rendered, inside `act`. */
function unmountAll(): void {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
}

/** Advance both the wall clock and the interval that reads it. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  unmountAll();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('formatElapsed', () => {
  it('counts seconds, then minutes and seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(9_400)).toBe('9s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(65_000)).toBe('1m 5s');
  });

  it('never reports a negative age', () => {
    // A clock skew between the daemon's `thinkingSince` and this machine can
    // put the anchor in the future; "-3s" would be the one reading that is
    // certainly wrong.
    expect(formatElapsed(-4_000)).toBe('0s');
  });
});

describe('liveRowKind', () => {
  it('recognises only the two live markers', () => {
    expect(liveRowKind({ live: 'thinking' })).toBe('thinking');
    expect(liveRowKind({ live: 'working' })).toBe('working');
    expect(liveRowKind({ live: 'something-else' })).toBeNull();
    // A DURABLE reasoning item carries text and no marker — it must never be
    // mistaken for a live row, or persisted history would render as a spinner.
    expect(liveRowKind({ text: 'I considered…' })).toBeNull();
    expect(liveRowKind(null)).toBeNull();
    expect(liveRowKind('nope')).toBeNull();
  });
});

describe('ThinkingRow', () => {
  it('counts real seconds while nothing new arrives', () => {
    // The defect: elapsed was computed inside the transcript fold, so it only
    // advanced when a delta happened to re-render — the counter jumped (30s →
    // 34s) instead of ticking. Nothing below changes a prop; the row must move
    // on its own or this assertion fails.
    vi.setSystemTime(new Date('2026-08-04T00:00:10Z'));
    const container = render(
      <ThinkingRow since={Date.parse('2026-08-04T00:00:00Z')} tokens={300} />,
    );
    expect(container.textContent).toContain('10s');

    advance(3_000);
    expect(container.textContent).toContain('13s');

    advance(1_000);
    expect(container.textContent).toContain('14s');
  });

  it('shows the stretch’s own token count', () => {
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(<ThinkingRow since={Date.now()} tokens={1_400} />);
    expect(container.textContent).toContain('1.4k tokens');
  });

  it('stops ticking once it leaves the transcript', () => {
    // A turn lands many stretches; a row that kept its interval after unmount
    // would leak one timer per stretch for the life of the chat.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    render(<ThinkingRow since={Date.now()} tokens={1} />);
    expect(vi.getTimerCount()).toBe(1);

    unmountAll();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('WorkingRow', () => {
  it('counts up from the moment it appears', () => {
    // It has no published anchor to read — the point is answering "how long
    // has this been quiet", which starts when the row does.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(<WorkingRow />);
    expect(container.textContent).toContain('Working…');
    expect(container.textContent).toContain('0s');

    advance(7_000);
    expect(container.textContent).toContain('7s');
  });
});

describe('the live rows say their state exactly once', () => {
  it.each([
    ['thinking', <ThinkingRow key="t" since={Date.now()} tokens={250} />],
    ['working', <WorkingRow key="w" />],
  ])('%s', (word, node) => {
    // Both rows rode MessageBubble's `role` caption, which prints its value in
    // uppercase above the body — so a row read "THINKING" over "Thinking… 250
    // tokens · 12s". Every other bubble needs that caption because its body is
    // the agent's own words; these two already name their state.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(node);

    const occurrences =
      (container.textContent ?? '').toLowerCase().split(word).length - 1;
    expect(occurrences).toBe(1);
  });
});
