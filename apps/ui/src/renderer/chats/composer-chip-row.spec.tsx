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

  it('charges nothing — not even a gap — for a position that renders nothing', () => {
    // Three real chips and their two gaps need exactly 206. The two zeros are
    // chips the current agent does not have (cursor's approval and effort);
    // charging them a gap apiece would need 210 and tip this over.
    expect(fitCount(206, [100, 0, 2, 0, 100], 32)).toBe(5);
  });

  it('never lets an empty position push a real chip into the overflow', () => {
    // The same widths as the row that fits above, minus the empties: what is
    // returned must still fit every real chip rather than reserving room for
    // controls that are not there.
    expect(fitCount(204, [0, 100, 100, 0], 32)).toBe(4);
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

  it('keeps a slot for a chip that renders nothing', () => {
    // The row measures by position, so a component returning null (cursor's
    // approval chip, a non-repo folder's branch chip) must still hold its
    // place — otherwise every later chip is measured into the wrong entry.
    act(() =>
      root.render(
        <ComposerChipRow actions={<button type="button">Send</button>}>
          <span data-slot="chip">one</span>
          <Absent />
          <span data-slot="chip">three</span>
        </ComposerChipRow>,
      ),
    );

    const row =
      container.querySelector('[data-slot="chip"]')!.parentElement!
        .parentElement!;
    expect(row.children).toHaveLength(3);
    expect(row.children[1]!.childElementCount).toBe(0);
  });
});

/** A chip component the current agent does not have — the null-rendering case. */
function Absent(): null {
  return null;
}

/**
 * Give jsdom the layout it does not do: the row reports {@link rowWidth}, and a
 * chip reports the width its `data-width` names. Enough for the component's
 * real measure→fit→render loop to run, which is the only way to drive the split
 * itself rather than the unmeasurable fallback.
 */
let rowWidth = 0;
const realRect = HTMLElement.prototype.getBoundingClientRect;

describe('ComposerChipRow — measured split', () => {
  beforeEach(() => {
    rowWidth = 0;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => rowWidth,
    });
    HTMLElement.prototype.getBoundingClientRect = function (
      this: HTMLElement,
    ): DOMRect {
      const width = Number(this.dataset.width ?? 0);
      return { ...realRect.call(this), width } as DOMRect;
    };
  });

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = realRect;
    Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  });

  const chip = (id: string, width: number): React.JSX.Element => (
    <span key={id} data-slot="chip" data-testid={id} data-width={width} />
  );

  const render = (children: React.ReactNode): void => {
    act(() =>
      root.render(
        <ComposerChipRow actions={<button type="button">Send</button>}>
          {children}
        </ComposerChipRow>,
      ),
    );
  };

  const overflowTrigger = (): Element | null =>
    container.querySelector('[aria-haspopup="dialog"]');

  it('overflows only what genuinely does not fit', () => {
    rowWidth = 250;
    render([chip('a', 100), chip('b', 100), chip('c', 100)]);

    // 100+2+100 = 202 fits with the … chip (236); the third does not.
    expect(container.querySelector('[data-testid="c"]')).toBeNull();
    expect(overflowTrigger()!.getAttribute('aria-label')).toBe('1 more option');
  });

  it('frees the row when a target switch empties a chip, instead of stranding one', () => {
    // The reported bug: a claude row (every chip present) switched to cursor,
    // whose approval chip renders nothing. Its width stayed in the cache, so
    // the row reserved space for a control that was gone and pushed the branch
    // chip into a … menu with a third of the row empty beside it.
    rowWidth = 350;
    render([chip('a', 100), chip('b', 100), chip('c', 100), chip('d', 100)]);
    expect(overflowTrigger()).not.toBeNull();

    render([
      chip('a', 100),
      <Absent key="b" />,
      chip('c', 100),
      chip('d', 100),
    ]);

    // 100+2+100+2+100 = 304, well inside 350 — nothing should be hidden.
    expect(container.querySelector('[data-testid="d"]')).not.toBeNull();
    expect(overflowTrigger()).toBeNull();
  });

  it('counts only the controls the menu actually holds', () => {
    // One real chip is left over, trailed by a position that renders nothing.
    // "2 more options" would promise a control the menu cannot show.
    rowWidth = 150;
    render([chip('a', 100), chip('b', 100), <Absent key="c" />]);

    expect(container.querySelector('[data-testid="b"]')).toBeNull();
    expect(overflowTrigger()!.getAttribute('aria-label')).toBe('1 more option');
  });
});
