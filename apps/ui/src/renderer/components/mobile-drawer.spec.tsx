// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileDrawer } from './mobile-drawer';

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

function draw(node: React.ReactNode): void {
  act(() => root.render(node));
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * The scrim carries no role and no accessible name on purpose — it is
 * `aria-hidden`, since a screen reader is served by the panel and its own
 * close control rather than by a decorative overlay. So these tests reach it
 * the way the DOM exposes it: the one `aria-hidden` element rendered beside
 * the panel.
 */
function backdrop(): HTMLElement | null {
  return container.querySelector<HTMLElement>(':scope > [aria-hidden="true"]');
}

function panel(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-panel]');
}

describe('MobileDrawer', () => {
  it('renders the scrim only while open', () => {
    draw(
      <MobileDrawer open={false} onClose={() => undefined}>
        <p>panel</p>
      </MobileDrawer>,
    );
    expect(backdrop()).toBeNull();

    draw(
      <MobileDrawer open onClose={() => undefined}>
        <p>panel</p>
      </MobileDrawer>,
    );
    expect(backdrop()).not.toBeNull();
  });

  it('closes on a tap on the scrim and not on one inside the panel', () => {
    const onClose = vi.fn();
    draw(
      <MobileDrawer open onClose={onClose}>
        <button type="button">inside</button>
      </MobileDrawer>,
    );

    const inside = container.querySelector('button');
    expect(inside).not.toBeNull();
    click(inside!);
    expect(onClose).not.toHaveBeenCalled();

    const scrim = backdrop();
    expect(scrim).not.toBeNull();
    click(scrim!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The class list is the real observable for this one: it is what ships, and
  // jsdom computes no layout to assert a rectangle against. `TitleBar` paints
  // `bg-sidebar` — the drawer panel's own surface — so a scrim over it turns
  // that black band grey and dims the very buttons that open and close the
  // drawer. Reverting this to `inset-0` is a one-token edit nothing else
  // would catch.
  it('starts the scrim below the title bar rather than over it', () => {
    draw(
      <MobileDrawer open onClose={() => undefined}>
        <p>panel</p>
      </MobileDrawer>,
    );

    expect(backdrop()?.className).toContain('top-11');
    expect(backdrop()?.className).not.toContain('inset-0');
  });

  // The panel is above its own scrim, always — the pair the component's own
  // comment calls load-bearing.
  it('keeps the panel above the scrim', () => {
    draw(
      <MobileDrawer open onClose={() => undefined} className="panel-surface">
        <p data-panel>panel</p>
      </MobileDrawer>,
    );

    expect(backdrop()?.className).toContain('z-40');
    expect(container.querySelector('.panel-surface')?.className).toContain(
      'max-sm:z-50',
    );
  });

  it('slides in from the asked-for edge and off it when closed', () => {
    draw(
      <MobileDrawer open={false} onClose={() => undefined} side="right">
        <p data-panel>panel</p>
      </MobileDrawer>,
    );
    const closed = panel()?.parentElement?.className ?? '';
    expect(closed).toContain('max-sm:right-0');
    expect(closed).toContain('max-sm:translate-x-full');

    draw(
      <MobileDrawer open onClose={() => undefined} side="right">
        <p data-panel>panel</p>
      </MobileDrawer>,
    );
    expect(panel()?.parentElement?.className).toContain('max-sm:translate-x-0');
  });

  it('renders the panel as the asked-for element', () => {
    draw(
      <MobileDrawer open onClose={() => undefined} as="aside">
        <p>panel</p>
      </MobileDrawer>,
    );
    expect(container.querySelector('aside')).not.toBeNull();
  });
});
