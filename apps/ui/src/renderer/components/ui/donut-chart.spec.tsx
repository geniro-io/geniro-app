// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { CONTEXT_CATEGORY_COLORS } from '../../chats/chat-metrics';
import {
  DonutChart,
  type DonutSlice,
  visibleSlices,
  wedgeToken,
} from './donut-chart';

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

function slices(...values: number[]): DonutSlice[] {
  return values.map((value, index) => ({
    key: `s${index}`,
    label: `Slice ${index}`,
    value,
  }));
}

/** Wedges are the circles past the track, which is always drawn first. */
const wedges = (el: HTMLElement): Element[] =>
  [...el.querySelectorAll('circle')].slice(1);

const dashLength = (node: Element): number =>
  Number(node.getAttribute('stroke-dasharray')?.split(' ')[0]);

describe('visibleSlices', () => {
  it('orders wedges largest first', () => {
    expect(visibleSlices(slices(1, 5, 3)).map((s) => s.value)).toEqual([
      5, 3, 1,
    ]);
  });

  it('drops slices worth nothing', () => {
    // A zero-width wedge is invisible but would still consume a palette colour
    // and a legend row.
    expect(visibleSlices(slices(4, 0, 2)).map((s) => s.value)).toEqual([4, 2]);
  });

  it('folds everything past the palette into one trailing slice', () => {
    const folded = visibleSlices(slices(10, 9, 8, 7, 6, 5, 4, 3, 2, 1));

    // Eight tokens, so seven are kept and the remaining three are summed — a
    // ninth wedge would repeat a colour, which reads as the same thing
    // appearing twice in the legend.
    expect(folded).toHaveLength(8);
    expect(folded.at(-1)).toMatchObject({ label: '3 more', value: 6 });
  });

  it('keeps every slice when they fit the palette exactly', () => {
    const exact = visibleSlices(slices(8, 7, 6, 5, 4, 3, 2, 1));
    expect(exact).toHaveLength(8);
    expect(exact.at(-1)?.label).toBe('Slice 7');
  });
});

describe('DonutChart', () => {
  it('draws one wedge per slice it was given, plus the track', () => {
    const el = render(
      <DonutChart slices={slices(3, 1)} ariaLabel="Spend by agent" />,
    );

    expect(el.querySelectorAll('circle')).toHaveLength(3);
    const svg = el.querySelector('[data-slot="donut-chart"]')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Spend by agent');
  });

  it('gives each wedge an arc proportional to its share', () => {
    const el = render(
      <DonutChart slices={slices(3, 1)} ariaLabel="Spend by agent" />,
    );

    const [first, second] = wedges(el) as [Element, Element];
    // Three quarters and one quarter of the same circumference.
    expect(
      dashLength(first) / (dashLength(first) + dashLength(second)),
    ).toBeCloseTo(0.75, 5);
    // The second wedge starts where the first ended, so they abut instead of
    // overlapping.
    expect(Number(second.getAttribute('stroke-dashoffset'))).toBeCloseTo(
      -dashLength(first),
      5,
    );
  });

  it('draws a single slice as a full ring', () => {
    const el = render(
      <DonutChart slices={slices(7)} ariaLabel="Spend by agent" />,
    );

    const [drawn, gap] = (
      wedges(el)[0]!.getAttribute('stroke-dasharray') as string
    ).split(' ');
    // The boundary a hand-rolled arc path gets wrong: at exactly 100% the
    // large-arc flag flips and the wedge collapses to a hairline.
    expect(Number(drawn)).toBeCloseTo(Number(gap), 5);
  });

  it('shows an empty ring rather than nothing when no slice was measured', () => {
    const el = render(
      <DonutChart slices={slices(0, 0)} ariaLabel="Spend by agent" />,
    );

    // An absent chart reads as a layout bug; an empty ring reads as no data.
    expect(el.querySelectorAll('circle')).toHaveLength(1);
    expect(
      el.querySelector('[data-slot="donut-chart"]')?.getAttribute('aria-label'),
    ).toBe('Spend by agent');
  });

  it('names each wedge for hover and assistive tech', () => {
    const el = render(
      <DonutChart slices={slices(3, 1)} ariaLabel="Spend by agent" />,
    );

    expect(
      [...el.querySelectorAll('title')].map((node) => node.textContent),
    ).toEqual(['Slice 0', 'Slice 1']);
  });
});

describe('wedgeToken', () => {
  it('hands the legend the same token the ring drew, position for position', () => {
    const el = render(
      <DonutChart slices={slices(3, 2, 1)} ariaLabel="Spend by agent" />,
    );

    wedges(el).forEach((wedge, index) => {
      expect(wedge.getAttribute('stroke')).toBe(wedgeToken(index));
    });
  });

  it('reads a token rather than a colour literal', () => {
    // The design-system rule: a hex/rgb()/hsl() here would be an eslint error
    // and would put the palette in two places.
    expect(wedgeToken(0)).toMatch(/^var\(--avatar-\d\)$/);
  });

  it('renders the slices in the order given, without re-folding them', () => {
    // The caller folds ONCE with `visibleSlices` and keys its legend swatches by
    // index. A second fold in here re-sorted that list — the trailing "N more"
    // slice can outweigh kept ones — so the swatch at index N named a different
    // slice than the wedge at index N. Passing a deliberately unsorted list is
    // what catches a reintroduced internal fold.
    const el = render(
      <DonutChart
        slices={[
          { key: 'a', label: 'A', value: 1 },
          { key: 'b', label: 'B', value: 9 },
        ]}
        ariaLabel="Spend by agent"
      />,
    );

    expect(
      [...el.querySelectorAll('title')].map((node) => node.textContent),
    ).toEqual(['A', 'B']);
  });

  it('cycles the SAME hues, in the same order, as the context breakdown', () => {
    // `chats/chat-metrics.ts` owns the rule that the app has ONE set of
    // distinguishable hues. It spells them as Tailwind classes because it
    // colours HTML; a wedge is an SVG `stroke` attribute and takes no class, so
    // the two forms are unavoidable — what is avoidable is them drifting, which
    // is what this pins. Reorder or extend either list alone and this fails.
    expect(
      CONTEXT_CATEGORY_COLORS.map((className) =>
        className.replace('bg-avatar-', ''),
      ),
    ).toEqual(
      CONTEXT_CATEGORY_COLORS.map((_, index) =>
        wedgeToken(index).replace('var(--avatar-', '').replace(')', ''),
      ),
    );
    // LENGTH too: without this, a ninth token added to the wedge palette alone
    // leaves both sides above unchanged — the mapping only ever samples indices
    // 0..7 — so the pin would miss exactly the drift it claims to catch.
    // `wedgeToken` wraps, so index 8 returning the first hue proves there is no
    // ninth.
    expect(wedgeToken(CONTEXT_CATEGORY_COLORS.length)).toBe(wedgeToken(0));
  });
});
