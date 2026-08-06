// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { Switch } from './switch';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

/** Tailwind's spacing step in CSS pixels — `*-4` is `1rem` at the default root. */
const STEP_PX = 4;

/** The track's own 1px border, on each side, from the primitive's base class. */
const BORDER_PX = 1;

/** Read one numeric Tailwind utility off an element, e.g. `w-7` → 28. */
function readUtility(element: Element, prefix: string): number {
  const match = [...element.classList]
    .map((name) => new RegExp(`^${prefix}-(\\d+(?:\\.\\d+)?)$`).exec(name))
    .find((found) => found !== null);
  const raw = match?.[1];
  if (raw === undefined) {
    // Loud rather than zero: a renamed utility must fail the lookup, not
    // quietly satisfy every inequality below.
    throw new Error(
      `no \`${prefix}-*\` class on <${element.tagName.toLowerCase()} class="${element.className}">`,
    );
  }
  return Number(raw) * STEP_PX;
}

/**
 * The switch's geometry, computed from the classes the component ACTUALLY
 * rendered rather than from numbers this spec chose.
 *
 * jsdom applies no Tailwind stylesheet, so `getBoundingClientRect` is all
 * zeroes and cannot answer this. Doing the same arithmetic a browser would keeps
 * the assertion about real geometry instead of about a class string: a spec
 * pinning `translate-x-3` as a literal would fail on every change, correct ones
 * included, and would have happily pinned the wrong literal the day it shipped.
 */
function geometryOf(track: HTMLElement): {
  trackInner: number;
  thumb: number;
  travel: number;
} {
  const thumb = track.firstElementChild;
  if (!thumb) {
    throw new Error('the switch rendered no thumb');
  }
  return {
    trackInner: readUtility(track, 'w') - BORDER_PX * 2,
    thumb: readUtility(thumb, 'size'),
    travel: [...thumb.classList].some((name) => name.startsWith('translate-x-'))
      ? readUtility(thumb, 'translate-x')
      : 0,
  };
}

function renderSwitch(props: Parameters<typeof Switch>[0]): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Switch {...props} />);
  });
  const track = container.querySelector('[role="switch"]');
  if (!(track instanceof HTMLElement)) {
    throw new Error('the switch did not render');
  }
  return track;
}

const SIZES = ['default', 'sm'] as const;

describe('Switch geometry', () => {
  for (const size of SIZES) {
    for (const checked of [false, true]) {
      it(`keeps the ${size} thumb inside its track when ${checked ? 'on' : 'off'}`, () => {
        // The bug this exists for: the MCP panel shrank the track with
        // `h-4 w-7` while the thumb kept `size-4` and `translate-x-4`, so an ON
        // switch put a 16px thumb at x=16 in a 26px inner track — 6px past the
        // edge, the thumb's own drop shadow hanging outside it.
        const { trackInner, thumb, travel } = geometryOf(
          renderSwitch({ checked, size, onCheckedChange: () => {} }),
        );

        expect(travel + thumb).toBeLessThanOrEqual(trackInner);
      });
    }

    it(`insets the ${size} thumb equally at both ends`, () => {
      // Containment alone is also satisfied by a thumb that never moves. This
      // is what makes the travel right rather than merely safe: the gap left
      // when ON must equal the gap it starts from when OFF.
      const off = geometryOf(
        renderSwitch({ checked: false, size, onCheckedChange: () => {} }),
      );
      act(() => {
        root?.render(<Switch checked size={size} onCheckedChange={() => {}} />);
      });
      const on = geometryOf(
        container?.querySelector('[role="switch"]') as HTMLElement,
      );

      expect(on.trackInner - (on.travel + on.thumb)).toBe(off.travel);
    });
  }

  it('stays full-size when no size is named', () => {
    // Settings renders it without a `size`, so the default must keep the shape
    // that shipped there rather than following the compact list down.
    const track = renderSwitch({ checked: true, onCheckedChange: () => {} });

    expect(geometryOf(track)).toEqual({
      trackInner: 34,
      thumb: 16,
      travel: 16,
    });
  });
});
