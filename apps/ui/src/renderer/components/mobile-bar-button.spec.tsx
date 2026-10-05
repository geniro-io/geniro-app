// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileBarButton } from './mobile-bar-button';

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

describe('MobileBarButton', () => {
  it('carries its label and fires on a press', () => {
    const onClick = vi.fn();
    draw(
      <MobileBarButton label="Back to chats" onClick={onClick}>
        <span>icon</span>
      </MobileBarButton>,
    );

    expect(button()?.getAttribute('aria-label')).toBe('Back to chats');
    act(() => button()?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('states aria-expanded only when the caller passes one', () => {
    draw(
      <MobileBarButton label="Open run details" onClick={() => undefined}>
        <span>icon</span>
      </MobileBarButton>,
    );
    expect(button()?.hasAttribute('aria-expanded')).toBe(false);

    draw(
      <MobileBarButton
        label="Open run details"
        expanded
        onClick={() => undefined}>
        <span>icon</span>
      </MobileBarButton>,
    );
    expect(button()?.getAttribute('aria-expanded')).toBe('true');
  });

  // The class list is the real observable — it is what ships, and jsdom
  // computes no layout to assert a rectangle against. A flex centre inside a
  // full-height band cannot drift when either height moves; an offset can:
  // `top-2` with a `size-9` button is 8 + 36 = 44, the band's own height, so
  // the button's bottom edge sat exactly on its border with no air under it.
  it('centres the button in the title bar band rather than offsetting it', () => {
    draw(
      <MobileBarButton label="Back to chats" onClick={() => undefined}>
        <span>icon</span>
      </MobileBarButton>,
    );

    const classes = band()?.className ?? '';
    expect(classes).toContain('h-11');
    expect(classes).toContain('items-center');
    expect(classes).toContain('top-0');
    // An offset from the top is exactly what this replaced.
    expect(classes).not.toMatch(/\btop-[1-9]/);
    // `TitleBar`'s `border-b` eats into its own `h-11`, so its content box is
    // 43px; without this the band centres on 44 and the button sits half a
    // pixel low — 8 device pixels of air above against 5 below, at 2x.
    expect(classes).toContain('pb-px');
  });

  // Reported as a box that was mostly chrome around a small glyph, and whose
  // own edge was what the eye judged the centring against: "let's leave just
  // icons". The 36px box stays as the TOUCH TARGET — invisible at rest, and
  // below any platform minimum without it — so what must be pinned is that it
  // paints nothing.
  it('draws a bare icon: no border, no fill, no shadow', () => {
    draw(
      <MobileBarButton label="Back to chats" onClick={() => undefined}>
        <span>icon</span>
      </MobileBarButton>,
    );

    const classes = button()?.className ?? '';
    expect(classes).not.toMatch(/\bborder\b/);
    expect(classes).not.toMatch(/\bbg-card\b/);
    expect(classes).not.toMatch(/\bshadow-/);
    // The tap area survives the chrome.
    expect(classes).toContain('size-9');
  });

  it('takes the caller’s placement and lets it override the default layer', () => {
    draw(
      <MobileBarButton
        label="Open run details"
        onClick={() => undefined}
        className="right-2 z-40">
        <span>icon</span>
      </MobileBarButton>,
    );

    const classes = band()?.className ?? '';
    expect(classes).toContain('right-2');
    expect(classes).toContain('z-40');
    expect(classes).not.toContain('z-50');
  });

  // At `sm` and wider every page it serves is an ordinary column already on
  // screen, so a floating button over them would be a second control for
  // something that is not hidden.
  it('is hidden from the sm breakpoint up', () => {
    draw(
      <MobileBarButton label="Back to chats" onClick={() => undefined}>
        <span>icon</span>
      </MobileBarButton>,
    );
    expect(band()?.classList.contains('sm:hidden')).toBe(true);
    expect(band()?.classList.contains('max-sm:hidden')).toBe(false);
  });
});
