// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { NOT_MEASURED } from '../stats-format';
import { categoryToken, ChartTooltip } from './chart-theme';

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

describe('ChartTooltip', () => {
  it('says a figure was not measured rather than showing a blank', () => {
    // The chart itself can only draw a gap, and a gap is ambiguous — it reads
    // as "nothing happened" just as easily as "nobody reported this". The
    // tooltip is the one surface that can state which, so it must.
    const el = render(
      <ChartTooltip
        title="Monday, 10 August 2026"
        rows={[{ label: 'Spend', value: '', unmeasured: true }]}
      />,
    );

    // Read the VALUE cell, not the whole panel: the heading is a date, and
    // "10 August 2026" contains the digits an over-broad `not.toContain('0')`
    // would trip on — a failure about the test's own fixture, not the code.
    const value = el.querySelector('li span:last-child')?.textContent;
    expect(value).toBe(NOT_MEASURED);
    expect(value).not.toContain('0');
  });

  it('shows a measured figure as given', () => {
    const el = render(
      <ChartTooltip
        title="Monday, 10 August 2026"
        rows={[
          { label: 'Spend', value: '$12.00' },
          { label: 'Turns', value: '4 turns' },
        ]}
      />,
    );

    expect(el.textContent).toContain('$12.00');
    expect(el.textContent).toContain('4 turns');
    expect(el.textContent).not.toContain(NOT_MEASURED);
  });

  it('shows a measured zero as zero, not as unmeasured', () => {
    // `unmeasured` is passed explicitly rather than inferred from a falsy
    // value, so a genuine $0.00 — a subscription-priced turn — still reads as
    // the figure somebody actually reported.
    const el = render(
      <ChartTooltip
        title="Monday, 10 August 2026"
        rows={[{ label: 'Spend', value: '$0.00' }]}
      />,
    );

    expect(el.textContent).toContain('$0.00');
    expect(el.textContent).not.toContain(NOT_MEASURED);
  });
});

describe('categoryToken', () => {
  it('reads a token, never a colour literal', () => {
    // The renderer's eslint config makes a hex an error, and a literal would
    // also stop following the theme. Every entry must be a var() reference.
    for (let index = 0; index < 10; index += 1) {
      expect(categoryToken(index)).toMatch(/^var\(--color-chart-\d\)$/);
    }
  });

  it('wraps past the end of the palette instead of running out', () => {
    // A breakdown is unbounded now that there is no fold, so row 5 must get a
    // colour rather than `undefined`, which would reach the DOM as no
    // background at all.
    expect(categoryToken(5)).toBe(categoryToken(0));
    expect(categoryToken(6)).toBe(categoryToken(1));
  });
});
