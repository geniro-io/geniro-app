// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { BarChart, type BarChartPoint } from './bar-chart';

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

function points(
  values: readonly (number | null)[],
  labels?: readonly string[],
): BarChartPoint[] {
  return values.map((value, index) => ({
    key: `p${index}`,
    label: labels?.[index] ?? `L${index}`,
    value,
  }));
}

const columns = (el: HTMLElement): HTMLElement[] => [
  ...el.querySelectorAll<HTMLElement>('[data-slot="bar-chart-column"]'),
];
const bars = (el: HTMLElement): HTMLElement[] => [
  ...el.querySelectorAll<HTMLElement>('[data-slot="bar-chart-bar"]'),
];
const labelText = (el: HTMLElement): string[] =>
  [
    ...el.querySelectorAll<HTMLElement>(
      '[data-slot="bar-chart"] > div:last-child > div',
    ),
  ].map((node) => node.textContent ?? '');

describe('BarChart', () => {
  it('draws one column per point and names the series for assistive tech', () => {
    const el = render(
      <BarChart points={points([1, 2, 3])} ariaLabel="Spend per day" />,
    );

    expect(columns(el)).toHaveLength(3);
    const chart = el.querySelector('[data-slot="bar-chart"]')!;
    expect(chart.getAttribute('role')).toBe('img');
    expect(chart.getAttribute('aria-label')).toBe('Spend per day');
  });

  it('scales each bar against the tallest value in the series', () => {
    const el = render(
      <BarChart points={points([5, 10])} ariaLabel="Spend per day" />,
    );

    const [half, peak] = bars(el) as [HTMLElement, HTMLElement];
    expect(peak.style.height).toBe('100%');
    expect(half.style.height).toBe('50%');
  });

  it('keeps a real but tiny value visible instead of rounding it away', () => {
    const el = render(
      <BarChart points={points([1, 10_000])} ariaLabel="Spend per day" />,
    );

    // 0.01% would be invisible; the floor is what stops a day that cost
    // something from looking exactly like a day that cost nothing.
    expect(bars(el)[0]!.style.height).toBe('1.5%');
  });

  it('draws nothing for an unmeasured point, but a hairline for a measured zero', () => {
    // The distinction the whole page rests on: a CLI that reports no cost has
    // not told us the day was free.
    const el = render(
      <BarChart points={points([null, 0, 4])} ariaLabel="Spend per day" />,
    );

    const [unmeasured, zero] = columns(el) as [HTMLElement, HTMLElement];
    expect(unmeasured.querySelector('[data-slot="bar-chart-bar"]')).toBeNull();
    const zeroBar = zero.querySelector<HTMLElement>(
      '[data-slot="bar-chart-bar"]',
    );
    expect(zeroBar).not.toBeNull();
    expect(zeroBar!.style.height).toBe('1.5%');
  });

  it('draws no bars for a series in which nothing was measured', () => {
    // No bar element is rendered at all here, so this does NOT pin the
    // divide-by-zero guard — the all-zero case below is what does. What it pins
    // is that the columns survive, keeping the axis continuous.
    const el = render(
      <BarChart points={points([null, null])} ariaLabel="Spend per day" />,
    );

    expect(bars(el)).toHaveLength(0);
    expect(columns(el)).toHaveLength(2);
  });

  it('scales a flat all-zero series without dividing by its own peak', () => {
    // The peak is 0 here AND bars are rendered, so an unguarded `value / peak`
    // yields NaN% and this fails.
    const el = render(
      <BarChart points={points([0, 0])} ariaLabel="Spend per day" />,
    );

    for (const bar of bars(el)) {
      expect(bar.style.height).toBe('1.5%');
    }
  });

  it('thins crowded x labels but always keeps the last one', () => {
    const labels = Array.from({ length: 30 }, (_, i) => `d${i}`);
    const el = render(
      <BarChart
        points={points(
          labels.map(() => 1),
          labels,
        )}
        ariaLabel="Spend per day"
      />,
    );

    const drawn = labelText(el).filter((text) => text !== '');
    // The right edge is "now" — the column a reader looks for first — so it is
    // labelled whatever the thinning interval works out to.
    expect(drawn).toContain('d29');
    expect(drawn).toContain('d0');
    expect(drawn).not.toContain('d1');
    expect(drawn.length).toBeLessThan(labels.length);
  });

  it('labels every column when the series is short enough to fit them', () => {
    const el = render(
      <BarChart
        points={points([1, 2, 3], ['Mon', 'Tue', 'Wed'])}
        ariaLabel="Spend per day"
      />,
    );

    expect(labelText(el)).toEqual(['Mon', 'Tue', 'Wed']);
  });

  it('hangs the caller’s sentence off the column, not the bar', () => {
    // The bar is absent on an unmeasured day, so a title attached to it would
    // leave exactly the days a reader most needs explained with no explanation.
    const el = render(
      <BarChart
        points={[
          { key: 'a', label: 'Mon', value: null, title: 'Mon — not measured' },
        ]}
        ariaLabel="Spend per day"
      />,
    );

    expect(columns(el)[0]!.title).toBe('Mon — not measured');
  });
});
