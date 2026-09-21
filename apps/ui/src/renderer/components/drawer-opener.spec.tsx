// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DrawerOpener } from './drawer-opener';

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

function button(): HTMLButtonElement | null {
  return container.querySelector('button');
}

function band(): HTMLElement | null {
  return container.querySelector<HTMLElement>(':scope > div');
}

describe('DrawerOpener', () => {
  it('carries its label and fires on a press', () => {
    const onClick = vi.fn();
    draw(
      <DrawerOpener label="Open navigation" onClick={onClick}>
        <span>icon</span>
      </DrawerOpener>,
    );

    expect(button()?.getAttribute('aria-label')).toBe('Open navigation');
    act(() => button()?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('states aria-expanded only when the caller passes one', () => {
    draw(
      <DrawerOpener label="Open chat list" onClick={() => undefined}>
        <span>icon</span>
      </DrawerOpener>,
    );
    expect(button()?.hasAttribute('aria-expanded')).toBe(false);

    draw(
      <DrawerOpener label="Close navigation" expanded onClick={() => undefined}>
        <span>icon</span>
      </DrawerOpener>,
    );
    expect(button()?.getAttribute('aria-expanded')).toBe('true');
  });

  // The whole reason this component exists. The class list is the real
  // observable — it is what ships, and jsdom computes no layout to assert a
  // rectangle against. Both openers previously carried `top-2` with a
  // `size-9` button: 8 + 36 = 44, the band's own height, so the button's
  // bottom edge sat exactly on its border with no air under it (measured on
  // the running remote page at 7.5px above, 0 below). A flex centre inside a
  // full-height band cannot drift when either height moves; an offset can.
  it('centres the button in the title bar band rather than offsetting it', () => {
    draw(
      <DrawerOpener label="Open navigation" onClick={() => undefined}>
        <span>icon</span>
      </DrawerOpener>,
    );

    const classes = band()?.className ?? '';
    expect(classes).toContain('h-11');
    expect(classes).toContain('items-center');
    expect(classes).toContain('top-0');
    // An offset from the top is exactly what this replaced.
    expect(classes).not.toMatch(/\btop-[1-9]/);
  });

  it('takes the caller’s placement and lets it override the default layer', () => {
    draw(
      <DrawerOpener
        label="Open chat list"
        onClick={() => undefined}
        className="left-14 z-40">
        <span>icon</span>
      </DrawerOpener>,
    );

    const classes = band()?.className ?? '';
    expect(classes).toContain('left-14');
    expect(classes).toContain('z-40');
    expect(classes).not.toContain('z-50');
  });

  // At `sm` and wider both drawers are ordinary columns already on screen, so
  // a floating opener over them would be a second control for a panel that is
  // not hidden.
  it('is hidden from the sm breakpoint up', () => {
    draw(
      <DrawerOpener label="Open navigation" onClick={() => undefined}>
        <span>icon</span>
      </DrawerOpener>,
    );
    expect(band()?.className).toContain('sm:hidden');
  });
});
