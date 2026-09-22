// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ComposingCard, formatComposedBytes } from './composing-card';
import type { GeniroCardKind } from './geniro-tool';

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

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.replaceChildren();
});

const KINDS: GeniroCardKind[] = [
  'artifact',
  'chart',
  'metrics',
  'comparison',
  'gallery',
  'findings',
  'patch',
  'plan',
];

describe('ComposingCard', () => {
  it('draws a silhouette for every card kind', () => {
    // The kind is the whole reason this is worth building rather than a
    // spinner: the shape says what to expect, so a kind that fell through to
    // an empty box would be a placeholder claiming a card and drawing none.
    for (const kind of KINDS) {
      const container = render(<ComposingCard kind={kind} />);
      const card = container.querySelector('[data-slot="composing-card"]');
      expect(card?.getAttribute('data-kind')).toBe(kind);
      expect(card?.querySelectorAll('.skeleton-pulse').length).toBeGreaterThan(
        0,
      );
    }
  });

  it('says it is busy, and names what is coming', () => {
    const container = render(<ComposingCard kind="artifact" />);
    const card = container.querySelector('[data-slot="composing-card"]');
    expect(card?.getAttribute('aria-busy')).toBe('true');
    expect(card?.getAttribute('aria-label')).toContain('Artifact');
    // It opens on the plain word, on `live-words.ts`'s rule.
    expect(container.textContent).toContain('Composing an interactive page…');
  });

  it('fabricates NO content — only boxes', () => {
    // The card that lands is the agent's, and this one may not put words in its
    // mouth: a skeleton carrying placeholder numbers or lorem text would be
    // indistinguishable from a real card until it was replaced.
    const container = render(<ComposingCard kind="metrics" bytes={4096} />);
    const skeleton = container.querySelector('[data-slot="composing-card"]');
    for (const bar of skeleton?.querySelectorAll('.skeleton-pulse') ?? []) {
      expect(bar.textContent).toBe('');
    }
  });

  it('shows how much of the call has been written', () => {
    // The one reading that separates a model still producing from one that has
    // stopped, on a wait measured in minutes.
    const container = render(<ComposingCard kind="artifact" bytes={12_800} />);
    expect(
      container.querySelector('[data-slot="composing-bytes"]')?.textContent,
    ).toContain('12.5 KB');
  });

  it('draws no figure at all when nothing measured it', () => {
    // A zero here would be a figure nobody reported — the null-means-not-
    // measured rule every other reading on this surface follows.
    const container = render(<ComposingCard kind="chart" />);
    expect(container.querySelector('[data-slot="composing-bytes"]')).toBeNull();
  });
});

describe('formatComposedBytes', () => {
  it('counts bytes below a kilobyte, then kilobytes', () => {
    expect(formatComposedBytes(0)).toBe('0 B');
    expect(formatComposedBytes(840)).toBe('840 B');
    expect(formatComposedBytes(2048)).toBe('2.0 KB');
  });

  it('drops the decimal once the figure is long enough not to need it', () => {
    expect(formatComposedBytes(1024 * 250)).toBe('250 KB');
  });
});
