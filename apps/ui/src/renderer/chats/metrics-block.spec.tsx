// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { MetricsCard } from './metrics-block';
import type { MetricsSpec } from './metrics-payload';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const SPEC: MetricsSpec = {
  title: 'After the caching change',
  metrics: [
    {
      label: 'Coverage',
      value: '82%',
      delta: '+4 pts',
      sentiment: 'good',
      note: 'lines, not branches',
    },
    {
      label: 'p95 latency',
      value: '410ms',
      delta: '+90ms',
      sentiment: 'bad',
      note: null,
    },
    {
      label: 'Flaky tests',
      value: '0',
      delta: null,
      sentiment: 'neutral',
      note: null,
    },
  ],
};

describe('MetricsCard', () => {
  it('draws every figure with its label, delta and note', () => {
    const el = render(<MetricsCard metrics={SPEC} />);
    expect(el.querySelectorAll('[data-slot="metric"]')).toHaveLength(3);
    const text = el.textContent ?? '';
    for (const shown of [
      'After the caching change',
      'Coverage',
      '82%',
      '+4 pts',
      'lines, not branches',
      '410ms',
      '+90ms',
      'Flaky tests',
      '0',
    ]) {
      expect(text).toContain(shown);
    }
  });

  it('colours by the STATED sentiment, not by the sign', () => {
    // The whole reason the field exists: `+4 pts` of coverage is good news and
    // `+90ms` of latency is bad, and both start with a plus. A card that read
    // the sign would paint one of them wrong.
    const el = render(<MetricsCard metrics={SPEC} />);
    const figures = [...el.querySelectorAll('[data-slot="metric"]')];
    const deltaClass = (index: number): string =>
      figures[index]?.querySelector('span > span:nth-child(2)')?.className ??
      '';
    expect(figures[0]?.getAttribute('data-sentiment')).toBe('good');
    expect(deltaClass(0)).toContain('text-success');
    expect(figures[1]?.getAttribute('data-sentiment')).toBe('bad');
    expect(deltaClass(1)).toContain('text-destructive');
  });

  it('omits the delta row entirely when there is none', () => {
    const el = render(
      <MetricsCard
        metrics={{
          title: null,
          metrics: [
            {
              label: 'Flaky tests',
              value: '0',
              delta: null,
              sentiment: 'neutral',
              note: null,
            },
          ],
        }}
      />,
    );
    const figure = el.querySelector('[data-slot="metric"]')!;
    expect(figure.querySelectorAll('span > span')).toHaveLength(1);
  });

  it('supplies its own heading when the agent named none', () => {
    const el = render(
      <MetricsCard
        metrics={{
          title: null,
          metrics: [
            {
              label: 'A',
              value: '1',
              delta: null,
              sentiment: 'neutral',
              note: null,
            },
          ],
        }}
      />,
    );
    expect(el.textContent).toContain('Figures');
  });

  it('is NOT behind a disclosure', () => {
    // The one real decision in the card: a chart earns a fold because it is
    // 190px of plot, a scorecard exists to be read at a glance, and a card you
    // must open to glance at is a link to one.
    const el = render(<MetricsCard metrics={SPEC} />);
    expect(el.querySelector('button')).toBeNull();
    expect(el.querySelector('[aria-expanded]')).toBeNull();
  });
});
