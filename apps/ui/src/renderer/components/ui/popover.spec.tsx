// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Menu } from './menu';
import { Popover } from './popover';

/**
 * The `anchor` contract, and only that.
 *
 * The default `ancestor` mode is absolute placement inside the nearest
 * positioned ancestor — which is CUT when that ancestor scrolls, and no CSS
 * restores it: `overflow-x: visible` cannot coexist with `overflow-y: auto`.
 * `viewport` mode exists to escape that, and these pin the two things a reader
 * would otherwise have to infer from a screenshot.
 */

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

/**
 * Stub the PANEL's own box, which jsdom reports as zero like everything else.
 *
 * On the prototype rather than the node: the panel is created inside
 * `Popover`, so a test has no handle on it before the placement effect reads
 * it. The trigger keeps its own-property stub, which wins over this.
 */
function stubPanelBox(size: { height: number; width: number }): () => void {
  const real = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this.getAttribute?.('role') === 'dialog') {
      return {
        top: 0,
        left: 0,
        bottom: size.height,
        right: size.width,
        ...size,
      } as DOMRect;
    }
    return real.call(this);
  };
  return () => {
    Element.prototype.getBoundingClientRect = real;
  };
}

const panelOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector('[role="dialog"]');

/** A trigger whose rect the panel is meant to be measured against. */
function Harness({
  anchor,
  rect,
  side = 'bottom',
}: {
  anchor?: 'ancestor' | 'viewport';
  rect?: Partial<DOMRect>;
  side?: 'top' | 'bottom';
}): React.JSX.Element {
  const ref = { current: null as HTMLButtonElement | null };
  const setRef = (node: HTMLButtonElement | null): void => {
    ref.current = node;
    if (node && rect) {
      // jsdom lays nothing out, so every rect is zero — the panel's placement
      // is a function of THIS rect, and stubbing it is what makes the arithmetic
      // observable at all.
      node.getBoundingClientRect = () =>
        ({ top: 0, left: 0, bottom: 0, right: 0, ...rect }) as DOMRect;
    }
  };
  return (
    <span className="relative">
      <button ref={setRef} type="button">
        trigger
      </button>
      <Popover
        open
        onClose={vi.fn()}
        triggerRef={ref}
        side={side}
        align="end"
        anchor={anchor}
        label="panel">
        body
      </Popover>
    </span>
  );
}

describe('the shared floating surface', () => {
  it('is the SAME surface under the menu and the popover', () => {
    // `popoverSurface` exists so elevation, radius and border cannot drift
    // between two things the user reads as one object — the claim its own doc
    // comment makes. Asserting the constant's text would only restate the
    // source; what this compares is two independently rendered components,
    // so a hand-rolled panel on either side breaks it.
    //
    // It has teeth because that drift is what was reported: the menu read as an
    // outlined wireframe rather than a lifted surface, and the fix was to move
    // the separation off the border and onto a real shadow — in ONE place, for
    // both.
    const popover = render(<Harness />).querySelector('[role="dialog"]')!;
    const menu = render(
      <Menu
        open
        groups={[{ items: [{ value: 'a', label: 'A' }] }]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    ).querySelector('[data-slot="menu-panel"]')!;

    for (const surface of [popover, menu]) {
      const classes = surface.className.split(/\s+/);
      expect(classes).toContain('shadow-panel-lg');
      expect(classes).toContain('border-border/60');
      expect(classes).toContain('rounded-xl');
      expect(classes).toContain('bg-popover');
    }
  });
});

describe('Popover — anchor="ancestor" (the default)', () => {
  it('places itself with absolute offsets and no inline box', () => {
    const panel = panelOf(render(<Harness />));

    // The utilities ARE the placement in this mode; an inline `position` here
    // would mean the fixed branch had leaked into every existing call site.
    expect(panel?.className).toContain('top-full');
    expect(panel?.className).toContain('right-0');
    expect(panel?.style.position).toBe('');
  });
});

describe('Popover — anchor="viewport"', () => {
  it('measures the trigger and pins the panel to the viewport instead', () => {
    // A trigger INSIDE the window — jsdom's is 1024 wide, and the earlier
    // fixture put the trigger's right edge at 1354, which is off-screen. That
    // was invisible while the offset was copied straight through; it is not
    // once the panel is kept inside the window, and an assertion computed from
    // the same formula the code uses could not have caught it either way.
    const panel = panelOf(
      render(<Harness anchor="viewport" rect={{ bottom: 140, right: 900 }} />),
    );

    // `fixed` is the ONLY thing that escapes a clipping ancestor. The measured
    // failure was a 390px panel cut at x=1121 by the scrolling thread list,
    // hiding the first 233px of every sentence it held — half of cursor's
    // "cannot reopen" reason, and half of claude's copyable `--resume` line.
    expect(panel?.style.position).toBe('fixed');
    expect(panel?.style.top).toBe('146px'); // rect.bottom + the 6px gap
    expect(panel?.style.right).toBe('124px'); // 1024 − 900, the trigger's edge
    // And the absolute utilities are GONE — left in place they would fight the
    // inline box (`right-0` resolving against the wrapper, not the viewport).
    expect(panel?.className).not.toContain('top-full');
    expect(panel?.className).not.toContain('right-0');
  });

  it('FLIPS above the trigger when the panel would run off the bottom', () => {
    // REPORTED as "этот поповер иногда заезжает за пределы окна видимого",
    // against a group's options opened on the last row of the sidebar: the
    // panel is `fixed` precisely so no ancestor can clip it, which also means
    // no ancestor can stop it. jsdom lays nothing out, so the panel's own
    // height is stubbed — it is the measurement the decision is made from, and
    // without it there is nothing to decide.
    const restore = stubPanelBox({ height: 300, width: 260 });
    try {
      // jsdom's window is 768 tall: a trigger ending at 700 leaves 62px below
      // and 700 above, so a 300px panel fits only upward.
      const panel = panelOf(
        render(
          <Harness
            anchor="viewport"
            rect={{ top: 680, bottom: 700, right: 900 }}
          />,
        ),
      );

      expect(panel?.style.bottom).toBe('94px'); // 768 − 680 + the 6px gap
      expect(panel?.style.top).toBe('');
    } finally {
      restore();
    }
  });

  it('keeps the requested side when the panel FITS there', () => {
    // The flip is a last resort, not a preference: a panel with room must not
    // move, or every popover in the app would jump to whichever side happened
    // to be roomier.
    const restore = stubPanelBox({ height: 120, width: 260 });
    try {
      const panel = panelOf(
        render(
          <Harness
            anchor="viewport"
            rect={{ top: 80, bottom: 100, right: 900 }}
          />,
        ),
      );

      expect(panel?.style.top).toBe('106px');
      expect(panel?.style.bottom).toBe('');
    } finally {
      restore();
    }
  });

  it('holds a panel too tall for EITHER side inside the window, scrolling', () => {
    // Nothing can be flipped to when both sides are short. Overflowing is the
    // one outcome that is never acceptable, so it scrolls inside itself.
    const restore = stubPanelBox({ height: 900, width: 260 });
    try {
      const panel = panelOf(
        render(
          <Harness
            anchor="viewport"
            rect={{ top: 380, bottom: 400, right: 900 }}
          />,
        ),
      );

      // 768 − 400 − 6 − 8 = 354 below, against 366 above — so it flips, and
      // the cap is what stops the 900px panel reaching past the top edge.
      expect(panel?.style.maxHeight).toBe('366px');
      expect(panel?.style.overflowY).toBe('auto');
    } finally {
      restore();
    }
  });

  it('never lets a wide panel cross the far edge of the window', () => {
    // The same rule across. A right-aligned panel overflows to the LEFT, which
    // no vertical fix would have caught.
    const restore = stubPanelBox({ height: 100, width: 900 });
    try {
      const panel = panelOf(
        render(
          <Harness anchor="viewport" rect={{ bottom: 140, right: 700 }} />,
        ),
      );

      // Pinning the trigger's own edge would be `right: 324px`, putting the
      // panel's LEFT edge at 1024 − 324 − 900 = −200. The ceiling is
      // 1024 − 900 − 8, which lands that edge on the 8px margin instead.
      expect(panel?.style.right).toBe('116px');
    } finally {
      restore();
    }
  });

  it('anchors to the trigger’s TOP edge for side="top"', () => {
    // Asserted because the fixed branch computes `bottom` from the WINDOW
    // height, which the absolute mode never had to do (`bottom-full` resolves
    // against the ancestor) — so getting it wrong is invisible in the other
    // mode and would put the panel off-screen only in this one.
    const panel = panelOf(
      render(
        <Harness
          anchor="viewport"
          side="top"
          rect={{ top: 300, right: 500 }}
        />,
      ),
    );

    expect(panel?.style.position).toBe('fixed');
    expect(panel?.style.bottom).toBe(`${window.innerHeight - 300 + 6}px`);
    expect(panel?.style.top).toBe('');
  });

  it('renders nothing until the trigger has been measured', () => {
    // Painting anyway would put the panel at the ancestor-relative position for
    // a frame before it jumped. No ref = no panel, rather than a misplaced one.
    const container = render(
      <Popover
        open
        onClose={vi.fn()}
        side="bottom"
        align="end"
        anchor="viewport"
        label="panel">
        body
      </Popover>,
    );

    expect(panelOf(container)).toBeNull();
  });
});
