// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { stubResizeObserver } from '../../__tests__/stub-resize-observer';
import type { DayPoint } from '../chart-data';
import { DailySeriesChart } from './time-charts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const day = (date: string, patch: Partial<DayPoint> = {}): DayPoint => ({
  date,
  label: date.slice(5),
  title: date,
  turns: 1,
  costUsd: 1,
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  cumulativeUsd: 1,
  threadsCreated: 1,
  pullRequests: 0,
  linesAdded: null,
  linesRemoved: null,
  linesPartial: false,
  avgWorkedMs: null,
  ...patch,
});

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

beforeAll(() => {
  stubResizeObserver();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

// The plot itself measures 0×0 under jsdom and draws no SVG, so these pin the
// chrome around it: whether a plot is offered at all, and the legend.
describe('DailySeriesChart', () => {
  it('says nothing was measured rather than drawing empty axes', () => {
    const el = render(
      <DailySeriesChart
        points={[day('2026-10-01'), day('2026-10-02')]}
        metric="lines"
      />,
    );
    expect(
      el.querySelector('[data-slot="daily-chart-empty"]')?.textContent,
    ).toBe('Nothing measured in this period.');
  });

  it('offers the plot once any day measured the metric', () => {
    const el = render(
      <DailySeriesChart
        points={[day('2026-10-01', { linesAdded: 0, linesRemoved: 0 })]}
        metric="lines"
      />,
    );
    expect(el.querySelector('[data-slot="daily-chart-empty"]')).toBeNull();
  });

  it('draws the removed swatch as light as its series', () => {
    const el = render(
      <DailySeriesChart
        points={[day('2026-10-01', { linesAdded: 3, linesRemoved: 1 })]}
        metric="lines"
      />,
    );
    const swatches = [...el.querySelectorAll('li span[aria-hidden="true"]')];
    const opacities = swatches.map(
      (swatch) => (swatch as HTMLElement).style.opacity,
    );
    expect(opacities).toEqual(['', '0.5']);
  });
});
