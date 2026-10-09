// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptCacheNotice } from './prompt-cache-notice';

const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const inMinutes = (minutes: number) =>
  new Date(NOW + minutes * 60_000).toISOString();

const roots: Root[] = [];

function render(node: React.ReactNode): {
  container: HTMLElement;
  rerender: (next: React.ReactNode) => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(node);
  });
  return {
    container,
    rerender: (next) => {
      act(() => {
        root.render(next);
      });
    },
  };
}

function notice(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-slot="prompt-cache-notice"]');
}

describe('PromptCacheNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    act(() => {
      for (const root of roots.splice(0)) {
        root.unmount();
      }
    });
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('warns that an expired cache makes the next message re-cache the context', () => {
    const { container } = render(
      <PromptCacheNotice expiresAt={inMinutes(-12)} contextTokens={184_000} />,
    );

    const line = notice(container);
    expect(line?.getAttribute('data-state')).toBe('expired');
    expect(line?.textContent).toContain('Prompt cache expired 12m ago');
    expect(line?.textContent).toContain('re-caches ~184k tokens of context');
  });

  it('names the whole conversation when the context size is unknown', () => {
    const { container } = render(
      <PromptCacheNotice expiresAt={inMinutes(-3)} contextTokens={null} />,
    );

    expect(notice(container)?.textContent).toContain(
      're-caches the whole conversation',
    );
  });

  it('draws nothing while the cache is warm, then counts down when it is due', () => {
    // An hour-long cache sleeps on ONE timer and wakes for the countdown —
    // which is what this observes: nothing at first, the countdown after.
    const { container } = render(
      <PromptCacheNotice expiresAt={inMinutes(30)} contextTokens={50_000} />,
    );
    expect(notice(container)).toBeNull();

    // The sleep ends at the countdown's start…
    act(() => {
      vi.advanceTimersByTime(28 * 60_000);
    });
    expect(notice(container)?.textContent).toContain(
      'Prompt cache expires in 2m 0s',
    );
    // …and from there it ticks every second (one `act` per tick, so React
    // commits and re-arms the next timer as a real clock would let it).
    for (let tick = 0; tick < 30; tick += 1) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(notice(container)?.textContent).toContain(
      'Prompt cache expires in 1m 30s',
    );
  });

  it('turns into the warning the moment the cache lapses', () => {
    const { container } = render(
      <PromptCacheNotice expiresAt={inMinutes(0.05)} contextTokens={50_000} />,
    );
    expect(notice(container)?.getAttribute('data-state')).toBe('expiring');

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(notice(container)?.textContent).toContain(
      'Prompt cache expired <1m ago',
    );
  });

  it('goes away when a new turn moves the expiry on', () => {
    const { container, rerender } = render(
      <PromptCacheNotice expiresAt={inMinutes(-5)} contextTokens={50_000} />,
    );
    expect(notice(container)).not.toBeNull();

    rerender(
      <PromptCacheNotice expiresAt={inMinutes(60)} contextTokens={50_000} />,
    );

    expect(notice(container)).toBeNull();
  });

  it('draws nothing for a run with no known expiry', () => {
    const { container } = render(
      <PromptCacheNotice expiresAt={null} contextTokens={50_000} />,
    );
    expect(notice(container)).toBeNull();
  });
});
