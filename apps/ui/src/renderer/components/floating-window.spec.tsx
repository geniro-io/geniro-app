// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountIntoDocument } from '../__tests__/mount-into-document';
import {
  clampWindow,
  cornerWindow,
  FloatingWindow,
  resizeWindow,
  WINDOW_HEAD_HEIGHT,
  WINDOW_MIN_SIZE,
} from './floating-window';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BOUNDS = { width: 1000, height: 700 };

describe('window geometry', () => {
  it('opens in the bottom-right corner of its bounds', () => {
    expect(cornerWindow(BOUNDS, { width: 400, height: 500 })).toEqual({
      x: 584,
      y: 184,
      width: 400,
      height: 500,
    });
  });

  it('keeps a window inside its bounds and never smaller than the least a window may be', () => {
    expect(
      clampWindow({ x: 900, y: -40, width: 200, height: 100 }, BOUNDS),
    ).toEqual({
      x: 1000 - WINDOW_MIN_SIZE.width,
      y: 0,
      width: WINDOW_MIN_SIZE.width,
      height: WINDOW_MIN_SIZE.height,
    });
  });

  it('resizes from the left edge keeping the right edge put, and from a corner on both sides', () => {
    const origin = { x: 500, y: 200, width: 400, height: 400 };
    expect(resizeWindow(origin, 'w', { dx: -100, dy: 50 }, BOUNDS)).toEqual({
      x: 400,
      y: 200,
      width: 500,
      height: 400,
    });
    expect(resizeWindow(origin, 'se', { dx: 50, dy: 60 }, BOUNDS)).toEqual({
      x: 500,
      y: 200,
      width: 450,
      height: 460,
    });
    expect(resizeWindow(origin, 'e', { dx: 5000, dy: 0 }, BOUNDS).width).toBe(
      500,
    );
  });
});

const render = mountIntoDocument();

describe('FloatingWindow', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(
      BOUNDS.width,
    );
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(
      BOUNDS.height,
    );
    Element.prototype.setPointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function draw(
    over: Partial<React.ComponentProps<typeof FloatingWindow>> = {},
  ): HTMLElement {
    return render(
      <FloatingWindow
        label="Manager chat"
        title="Manager"
        open
        initialRect={() => ({ x: 500, y: 200, width: 400, height: 400 })}
        onClose={() => undefined}
        {...over}>
        <span data-slot="window-content">chat</span>
      </FloatingWindow>,
    );
  }

  const windowOf = (el: HTMLElement): HTMLElement =>
    el.querySelector<HTMLElement>('[data-slot="floating-window"]')!;

  const press = (target: Element, type: string, x: number, y: number): void => {
    act(() => {
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y,
        }),
      );
    });
  };

  it('moves by its head and stays inside the page', () => {
    const el = draw();
    const head = el.querySelector('[data-slot="floating-window-head"]')!;
    press(head, 'pointerdown', 100, 100);
    press(head, 'pointermove', 40, 160);
    press(head, 'pointerup', 40, 160);
    expect(windowOf(el).style.left).toBe('440px');
    expect(windowOf(el).style.top).toBe('260px');

    press(head, 'pointerdown', 100, 100);
    press(head, 'pointermove', 2000, 2000);
    press(head, 'pointerup', 2000, 2000);
    expect(windowOf(el).style.left).toBe('600px');
    expect(windowOf(el).style.top).toBe('300px');
  });

  it('resizes from an edge', () => {
    const el = draw();
    const left = el.querySelector(
      '[data-slot="floating-window-resize"][data-edge="w"]',
    )!;
    press(left, 'pointerdown', 500, 300);
    press(left, 'pointermove', 400, 300);
    press(left, 'pointerup', 400, 300);
    expect(windowOf(el).style.left).toBe('400px');
    expect(windowOf(el).style.width).toBe('500px');
  });

  it('minimises to its head and restores, keeping what it holds mounted', () => {
    const el = draw();
    act(() =>
      el
        .querySelector<HTMLButtonElement>(
          '[data-slot="floating-window-minimise"]',
        )!
        .click(),
    );
    expect(windowOf(el).dataset.state).toBe('minimised');
    expect(windowOf(el).style.height).toBe(`${WINDOW_HEAD_HEIGHT}px`);
    const body = el.querySelector<HTMLElement>(
      '[data-slot="floating-window-body"]',
    )!;
    expect(body.hidden).toBe(true);
    expect(el.querySelector('[data-slot="window-content"]')).not.toBeNull();

    act(() =>
      el
        .querySelector<HTMLButtonElement>(
          '[data-slot="floating-window-minimise"]',
        )!
        .click(),
    );
    expect(windowOf(el).dataset.state).toBe('open');
    expect(windowOf(el).style.height).toBe('400px');
  });

  it('maximises to fill the page and restores to where it stood', () => {
    const el = draw();
    const maximise = (): void =>
      act(() =>
        el
          .querySelector<HTMLButtonElement>(
            '[data-slot="floating-window-maximise"]',
          )!
          .click(),
      );
    maximise();
    expect(windowOf(el).dataset.state).toBe('maximised');
    expect(windowOf(el).style.width).toBe('1000px');
    expect(windowOf(el).style.height).toBe('700px');
    expect(
      el.querySelectorAll('[data-slot="floating-window-resize"]'),
    ).toHaveLength(0);

    maximise();
    expect(windowOf(el).style.left).toBe('500px');
    expect(windowOf(el).style.width).toBe('400px');
  });

  it('gives each head control its own icon, name and title in every state', () => {
    const el = draw();
    const head = (): { icon: string; label: string; title: string }[] =>
      ['minimise', 'maximise', 'close'].map((control) => {
        const button = el.querySelector<HTMLButtonElement>(
          `[data-slot="floating-window-${control}"]`,
        )!;
        return {
          icon: button.querySelector('svg')!.getAttribute('class')!,
          label: button.getAttribute('aria-label')!,
          title: button.title,
        };
      });
    const distinct = (
      controls: { icon: string; label: string; title: string }[],
    ): void => {
      for (const key of ['icon', 'label', 'title'] as const) {
        expect(new Set(controls.map((control) => control[key])).size).toBe(3);
      }
    };
    const pressHead = (control: string): void =>
      act(() =>
        el
          .querySelector<HTMLButtonElement>(
            `[data-slot="floating-window-${control}"]`,
          )!
          .click(),
      );

    distinct(head());

    pressHead('minimise');
    expect(windowOf(el).dataset.state).toBe('minimised');
    const minimised = head();
    distinct(minimised);
    expect(minimised[0]).toMatchObject({
      label: 'Restore Manager chat',
      title: 'Restore',
      icon: expect.stringContaining('lucide-chevron-up'),
    });
    expect(minimised[1]).toMatchObject({
      label: 'Maximise Manager chat',
      title: 'Maximise',
      icon: expect.stringContaining('lucide-maximize'),
    });

    pressHead('maximise');
    expect(windowOf(el).dataset.state).toBe('maximised');
    distinct(head());
  });

  it('reports a press anywhere in it, its head and its body alike', () => {
    const onActivate = vi.fn();
    const el = draw({ onActivate });
    press(
      el.querySelector('[data-slot="window-content"]')!,
      'pointerdown',
      600,
      400,
    );
    expect(onActivate).toHaveBeenCalledTimes(1);
    press(
      el.querySelector('[data-slot="floating-window-maximise"]')!,
      'pointerdown',
      860,
      220,
    );
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('closes from its head', () => {
    const onClose = vi.fn();
    const el = draw({ onClose });
    act(() =>
      el
        .querySelector<HTMLButtonElement>(
          '[data-slot="floating-window-close"]',
        )!
        .click(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays mounted and hidden while closed, so what it holds keeps its state', () => {
    const el = draw({ open: false });
    expect(
      el.querySelector<HTMLElement>('[data-slot="floating-window-bounds"]')!
        .hidden,
    ).toBe(true);
    expect(el.querySelector('[data-slot="window-content"]')).not.toBeNull();
  });

  it('stays inside its page on a desktop', () => {
    const bounds = draw().querySelector<HTMLElement>(
      '[data-slot="floating-window-bounds"]',
    )!;
    expect(bounds.classList).toContain('absolute');
    expect(bounds.classList).not.toContain('fixed');
  });

  it('covers the whole screen on a phone, over the app header and tab bar, with no way to move, resize, minimise or maximise it', () => {
    const el = draw({ phone: true });
    const bounds = el.querySelector<HTMLElement>(
      '[data-slot="floating-window-bounds"]',
    )!;
    expect(bounds.classList).toContain('fixed');
    expect(bounds.classList).toContain('inset-0');
    expect(bounds.classList).toContain('z-50');
    expect(windowOf(el).dataset.phone).toBe('true');
    expect(windowOf(el).className).toContain('inset-0');
    expect(windowOf(el).className).toContain(
      'pb-[env(safe-area-inset-bottom)]',
    );
    expect(
      el.querySelector('[data-slot="floating-window-close"]'),
    ).not.toBeNull();
    expect(
      el.querySelectorAll('[data-slot="floating-window-resize"]'),
    ).toHaveLength(0);
    expect(
      el.querySelector('[data-slot="floating-window-minimise"]'),
    ).toBeNull();
    expect(
      el.querySelector('[data-slot="floating-window-maximise"]'),
    ).toBeNull();
  });
});
