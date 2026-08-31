// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { ChartCard } from './chart-block';
import type { ChartSpec } from './chart-payload';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * recharts observes its container to size itself, and jsdom ships no
 * `ResizeObserver`. Stubbed rather than worked around: without it the card
 * throws on mount and NOTHING here could be asserted, and what these tests
 * cover is the chrome around the plot — the heading, the captions, the legend,
 * the disclosure — every part of the card that carries words.
 *
 * The plot itself is deliberately not asserted, for the reason
 * `stats/charts/time-charts.spec.ts` already records: `ResponsiveContainer`
 * measures 0×0 in jsdom, so the SVG is empty whatever the data says, and a test
 * over it would pin the measurement rather than the chart.
 */
stubResizeObserver();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const chart = (overrides: Partial<ChartSpec> = {}): ChartSpec => ({
  title: 'Test suite duration',
  kind: 'line',
  labels: ['a1b2', 'c3d4'],
  series: [{ name: 'unit', values: [12.1, 13.4] }],
  xLabel: null,
  yLabel: null,
  ...overrides,
});

function draw(spec: ChartSpec): HTMLElement {
  act(() => root.render(<ChartCard chart={spec} />));
  return container.querySelector<HTMLElement>('[data-slot="chart-card"]')!;
}

describe('ChartCard', () => {
  it('leads with the agent’s own title', () => {
    expect(draw(chart()).textContent).toContain('Test suite duration');
  });

  it('supplies a heading when the agent named none, rather than a blank row', () => {
    expect(draw(chart({ title: null })).textContent).toContain('Chart');
  });

  it('says how many series only when there is more than one', () => {
    expect(draw(chart()).textContent).not.toContain('series');
    const many = draw(
      chart({
        series: [
          { name: 'unit', values: [1, 2] },
          { name: 'integration', values: [3, 4] },
        ],
      }),
    );
    expect(many.textContent).toContain('2 series');
  });

  it('names the kind on the element, which is otherwise invisible from outside', () => {
    expect(draw(chart({ kind: 'bar' })).dataset.kind).toBe('bar');
    expect(draw(chart({ kind: 'area' })).dataset.kind).toBe('area');
  });

  it('opens showing the plot, and the header collapses it', () => {
    // A chart is the answer to something the user asked for, so it arrives
    // drawn rather than as a line to press.
    const card = draw(chart({ yLabel: 'seconds' }));
    expect(card.dataset.open).toBe('true');
    expect(card.textContent).toContain('seconds');

    const header = card.querySelector('button')!;
    act(() => header.click());

    expect(card.dataset.open).toBe('false');
    // Collapsed means collapsed: the captions go with the plot, or the card
    // keeps claiming a unit for numbers nobody can see.
    expect(card.textContent).not.toContain('seconds');
    expect(card.textContent).toContain('Test suite duration');
  });

  it('captions both axes when the agent named them, and neither when it did not', () => {
    const both = draw(chart({ xLabel: 'commit', yLabel: 'seconds' }));
    expect(both.textContent).toContain('commit');
    expect(both.textContent).toContain('seconds');
    const neither = draw(chart());
    expect(neither.textContent).not.toContain('commit');
    expect(neither.textContent).not.toContain('seconds');
  });

  it('draws a legend only where colour is carrying information', () => {
    // One series needs no key to tell it from the others.
    expect(draw(chart()).querySelectorAll('li')).toHaveLength(0);
    const many = draw(
      chart({
        series: [
          { name: 'unit', values: [1, 2] },
          { name: 'integration', values: [3, 4] },
        ],
      }),
    );
    expect(
      [...many.querySelectorAll('li')].map((li) => li.textContent),
    ).toEqual(['unit', 'integration']);
  });

  it('keys a multi-line legend by PATTERN, not by five shades of one hue', () => {
    // The palette is a warm ramp — chosen for ranked rows that carry their own
    // label — so on a line chart colour alone cannot tie a curve to its name.
    // The swatch has to show the pattern the curve is actually drawn with, or
    // it is a key the reader cannot match to anything.
    const card = draw(
      chart({
        series: [
          { name: 'unit', values: [1, 2] },
          { name: 'integration', values: [3, 4] },
          { name: 'e2e', values: [5, 6] },
        ],
      }),
    );
    const swatches = [...card.querySelectorAll('li')].map((li) =>
      li.querySelector('line')?.getAttribute('stroke-dasharray'),
    );
    // The first stays solid, so the common single-series chart is untouched…
    expect(swatches[0] ?? null).toBeNull();
    // …and the rest are distinct patterns rather than repeats.
    expect(swatches[1]).toBeTruthy();
    expect(swatches[2]).toBeTruthy();
    expect(swatches[1]).not.toBe(swatches[2]);
  });

  it('leaves a BAR legend as dots — bars do not overlap, so a dash buys nothing', () => {
    const card = draw(
      chart({
        kind: 'bar',
        series: [
          { name: 'unit', values: [1, 2] },
          { name: 'integration', values: [3, 4] },
        ],
      }),
    );
    expect(card.querySelectorAll('li line')).toHaveLength(0);
    expect(card.querySelectorAll('li')).toHaveLength(2);
  });
});
