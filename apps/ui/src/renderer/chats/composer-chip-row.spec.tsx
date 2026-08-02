// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ComposerChipRow, fitCount } from './composer-chip-row';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

/** Gap between chips — the constant the component lays the row out with. */
const GAP = 2;

describe('fitCount — what stays on the row', () => {
  // The layout rule itself, driven directly: jsdom measures nothing, so a
  // rendering test could only ever exercise the unmeasurable fallback below.
  it('keeps every chip when they all fit', () => {
    expect(fitCount(300, [100, 100, 90], 32)).toBe(3);
  });

  it('counts the gaps, not just the chips', () => {
    // 100+100+90 = 290 fits in 292 only if the two gaps are ignored.
    expect(fitCount(292, [100, 100, 90], 32)).toBe(2);
  });

  it('leaves room for the overflow chip itself', () => {
    // Three 100s and their gaps need 304; at 340 the first three fit outright,
    // but the fourth is left over — so the … chip has to fit as well, and only
    // two chips plus the … (100+2+100+2+32 = 236) do.
    expect(fitCount(240, [100, 100, 100, 100], 32)).toBe(2);
  });

  it('gives up the whole row rather than hide the overflow chip', () => {
    // Narrower than one chip plus the …: everything moves into the menu, which
    // still reaches every control. Hiding the … instead would strand them.
    expect(fitCount(110, [100, 100], 32)).toBe(0);
  });

  it('fits a chip that lands exactly on the edge', () => {
    expect(fitCount(100 + GAP + 100, [100, 100], 32)).toBe(2);
  });
});

describe('ComposerChipRow', () => {
  it('shows every chip when the DOM reports no layout at all', () => {
    // jsdom (and the first paint of a real one) measures 0 for everything.
    // Guessing a split from that would hide working controls; showing them all
    // is what a row with room looks like.
    act(() =>
      root.render(
        <ComposerChipRow actions={<button type="button">Send</button>}>
          <span data-slot="chip">one</span>
          <span data-slot="chip">two</span>
          <span data-slot="chip">three</span>
        </ComposerChipRow>,
      ),
    );

    expect(container.querySelectorAll('[data-slot="chip"]')).toHaveLength(3);
    expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull();
  });

  it('never puts the actions inside the box that overflows', () => {
    act(() =>
      root.render(
        <ComposerChipRow actions={<button type="button">Send</button>}>
          <span data-slot="chip">one</span>
        </ComposerChipRow>,
      ),
    );

    const send = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Send',
    )!;
    const chip = container.querySelector('[data-slot="chip"]')!;
    expect(chip.parentElement!.contains(send)).toBe(false);
  });
});
