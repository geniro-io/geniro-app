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
    expect(line?.textContent).toContain('re-caches ~184k tokens at full price');
  });

  it('is the warning strip, read politely rather than as an alert', () => {
    // A countdown ticks every second; as `role="alert"` it would be read out on
    // every tick.
    const { container } = render(
      <PromptCacheNotice expiresAt={inMinutes(1)} contextTokens={50_000} />,
    );

    const line = notice(container);
    expect(line?.getAttribute('data-tone')).toBe('warning');
    expect(line?.querySelector('[role="status"]')).not.toBeNull();
    expect(line?.querySelector('[role="alert"]')).toBeNull();
  });

  it('says why the cache is short when the CLI gave a reason', () => {
    // A five-minute cache on a subscription read as a bug until the strip
    // said the account had been on extra usage.
    const { container } = render(
      <PromptCacheNotice
        expiresAt={inMinutes(-3)}
        ttlMs={300_000}
        ttlReason="extra-usage"
        contextTokens={793_900}
      />,
    );

    expect(notice(container)?.textContent).toContain(
      'On extra usage the cache lasts only 5 minutes.',
    );
  });

  it('states no reason the CLI did not give', () => {
    const { container } = render(
      <PromptCacheNotice
        expiresAt={inMinutes(-4)}
        ttlMs={3_600_000}
        ttlReason={null}
        contextTokens={50_000}
      />,
    );

    expect(notice(container)?.textContent).not.toContain('extra usage');
  });

  it('closes, and comes back for the next cache', () => {
    const closed = inMinutes(-9);
    const { container, rerender } = render(
      <PromptCacheNotice expiresAt={closed} contextTokens={50_000} />,
    );

    const close = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss warning"]',
    );
    act(() => {
      close?.click();
    });
    expect(notice(container)).toBeNull();

    // The same expiry stays closed across a re-render (another chat and back)…
    rerender(<PromptCacheNotice expiresAt={closed} contextTokens={50_000} />);
    expect(notice(container)).toBeNull();

    // …while a new turn's expiry is a new cache to warn about.
    rerender(
      <PromptCacheNotice expiresAt={inMinutes(-1.5)} contextTokens={50_000} />,
    );
    expect(notice(container)).not.toBeNull();
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
