// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptCacheBadge } from './prompt-cache-badge';

const NOW = Date.parse('2026-10-11T10:00:00.000Z');
const inMinutes = (minutes: number) =>
  new Date(NOW + minutes * 60_000).toISOString();

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

function badge(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-slot="prompt-cache-badge"]');
}

describe('PromptCacheBadge', () => {
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

  it('counts down a warm cache in minutes', () => {
    const el = render(
      <PromptCacheBadge
        expiresAt={inMinutes(42)}
        contextTokens={700_000}
        contextWindowTokens={1_000_000}
      />,
    );
    expect(badge(el)?.dataset.state).toBe('warm');
    expect(badge(el)?.textContent).toBe('42m');
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(badge(el)?.textContent).toBe('32m');
  });

  it('turns cold when the cache lapses, and says start fresh over half the window', () => {
    const el = render(
      <PromptCacheBadge
        expiresAt={inMinutes(1)}
        contextTokens={700_000}
        contextWindowTokens={1_000_000}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(badge(el)?.dataset.state).toBe('start-fresh');
    expect(badge(el)?.textContent).toBe('cold');
    expect(badge(el)?.getAttribute('title')).toContain(
      'a new instance with a brief is cheaper',
    );
  });

  it('agrees with the daemon at the boundary: just over half is start fresh, though it rounds to 50%', () => {
    const el = render(
      <PromptCacheBadge
        expiresAt={inMinutes(-5)}
        contextTokens={500_400}
        contextWindowTokens={1_000_000}
      />,
    );
    expect(badge(el)?.dataset.state).toBe('start-fresh');
    expect(badge(el)?.getAttribute('title')).toContain('50.1% full');
  });

  it('is cold without the start-fresh warning at or under half the window', () => {
    const el = render(
      <PromptCacheBadge
        expiresAt={inMinutes(-5)}
        contextTokens={500_000}
        contextWindowTokens={1_000_000}
      />,
    );
    expect(badge(el)?.dataset.state).toBe('expired');
  });

  it('draws nothing while the instance works, or without an expiry', () => {
    expect(
      badge(
        render(
          <PromptCacheBadge
            expiresAt={inMinutes(42)}
            contextTokens={1}
            contextWindowTokens={2}
            live
          />,
        ),
      ),
    ).toBeNull();
    expect(
      badge(
        render(
          <PromptCacheBadge
            expiresAt={null}
            contextTokens={1}
            contextWindowTokens={2}
          />,
        ),
      ),
    ).toBeNull();
  });

  it('draws the line exactly where the daemon refuses a cold resume', () => {
    // TWIN: the daemon's COLD_RESUME_CONTEXT_PERCENT, read from its own source
    // so the badge cannot drift from the rule the calling agent is held to.
    const daemon = readFileSync(
      join(
        __dirname,
        '../../../../daemon/src/v1/graphs/utils/prompt-cache-standing.ts',
      ),
      'utf8',
    );
    const percent = Number(
      /COLD_RESUME_CONTEXT_PERCENT = (\d+)/.exec(daemon)?.[1],
    );
    expect(percent).toBeGreaterThan(0);
    const at = (tokens: number) =>
      badge(
        render(
          <PromptCacheBadge
            expiresAt={inMinutes(-5)}
            contextTokens={tokens}
            contextWindowTokens={100_000}
          />,
        ),
      )?.dataset.state;
    expect(at(percent * 1_000)).toBe('expired');
    expect(at(percent * 1_000 + 1)).toBe('start-fresh');
  });
});
