// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  cascadeRect,
  clampRect,
  type FloatingRect,
  FloatingWindow,
} from './floating-window';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BOUNDS = { width: 1000, height: 800 };
const START: FloatingRect = { x: 100, y: 50, width: 400, height: 300 };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  Element.prototype.setPointerCapture = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderWindow(
  over: Partial<ComponentProps<typeof FloatingWindow>> = {},
): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <FloatingWindow
        label="Thread Ada"
        title="Ada · running"
        rect={START}
        onRectChange={vi.fn()}
        bounds={BOUNDS}
        zIndex={10}
        onFocus={vi.fn()}
        onClose={vi.fn()}
        {...over}>
        <p>Body text</p>
      </FloatingWindow>,
    ),
  );
  return container;
}

function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  pointerId = 1,
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

function fire(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  pointerId = 1,
): void {
  act(() => {
    target.dispatchEvent(pointer(type, x, y, pointerId));
  });
}

const headerOf = (el: HTMLElement): HTMLElement =>
  el.querySelector<HTMLElement>('[data-slot="floating-window-header"]')!;

const handleOf = (el: HTMLElement, edge: string): HTMLElement =>
  el.querySelector<HTMLElement>(
    `[data-slot="floating-window-resize"][data-edge="${edge}"]`,
  )!;

const closeButtonOf = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>('button[aria-label="Close Thread Ada"]')!;

describe('clampRect', () => {
  it('keeps a rect that already fits where it is', () => {
    expect(clampRect(START, BOUNDS)).toEqual(START);
  });

  it('pulls an overflowing rect back onto the right and bottom edges', () => {
    expect(
      clampRect({ x: 900, y: 700, width: 400, height: 300 }, BOUNDS),
    ).toEqual({ x: 600, y: 500, width: 400, height: 300 });
  });

  it('stops a rect at the top-left corner', () => {
    expect(
      clampRect({ x: -30, y: -5, width: 400, height: 300 }, BOUNDS),
    ).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it('floors the size at the minimum', () => {
    expect(
      clampRect({ x: 10, y: 10, width: 100, height: 100 }, BOUNDS),
    ).toEqual({ x: 10, y: 10, width: 320, height: 240 });
  });

  it('caps the size at smaller bounds, the minimum winning and x and y pinned to 0', () => {
    expect(
      clampRect(
        { x: 50, y: 50, width: 900, height: 900 },
        { width: 500, height: 200 },
      ),
    ).toEqual({ x: 0, y: 0, width: 500, height: 240 });
  });

  it('keeps x and y before the container is measured, and floors the size', () => {
    expect(
      clampRect(
        { x: 40, y: -10, width: 100, height: 100 },
        { width: 0, height: 0 },
      ),
    ).toEqual({ x: 40, y: 0, width: 320, height: 240 });
  });
});

describe('cascadeRect', () => {
  it('places the first window 16px in at its default size', () => {
    expect(cascadeRect(0, BOUNDS)).toEqual({
      x: 16,
      y: 16,
      width: 460,
      height: 560,
    });
  });

  it('steps each window 28px further in', () => {
    expect(cascadeRect(2, BOUNDS)).toMatchObject({ x: 72, y: 72 });
  });

  it('wraps the cascade after eight windows', () => {
    expect(cascadeRect(8, BOUNDS)).toMatchObject({ x: 16, y: 16 });
  });

  it('stays inside a small container', () => {
    expect(cascadeRect(3, { width: 500, height: 600 })).toEqual({
      x: 40,
      y: 40,
      width: 460,
      height: 560,
    });
  });
});

describe('FloatingWindow', () => {
  it('is a non-modal dialog named after its label', () => {
    const dialog = renderWindow().querySelector('[role="dialog"]')!;

    expect(dialog.getAttribute('aria-label')).toBe('Thread Ada');
    expect(dialog.getAttribute('aria-modal')).toBe('false');
  });

  it('sits at its rect and stacks at its z-index', () => {
    const dialog = renderWindow().querySelector<HTMLElement>(
      '[data-slot="floating-window"]',
    )!;

    expect(dialog.style.left).toBe('100px');
    expect(dialog.style.top).toBe('50px');
    expect(dialog.style.width).toBe('400px');
    expect(dialog.style.height).toBe('300px');
    expect(dialog.style.zIndex).toBe('10');
  });

  it('draws the body children in the window', () => {
    expect(renderWindow().textContent).toContain('Body text');
  });

  it('drags from the header and keeps the window inside the bounds', () => {
    const onRectChange = vi.fn();
    const el = renderWindow({ onRectChange });
    const header = headerOf(el);

    fire(header, 'pointerdown', 200, 100);
    fire(header, 'pointermove', 260, 130);
    expect(onRectChange).toHaveBeenLastCalledWith({
      x: 160,
      y: 80,
      width: 400,
      height: 300,
    });

    fire(header, 'pointermove', 5000, 100);
    expect(onRectChange).toHaveBeenLastCalledWith({
      x: 600,
      y: 50,
      width: 400,
      height: 300,
    });

    fire(header, 'pointerup', 5000, 100);
    const calls = onRectChange.mock.calls.length;
    fire(header, 'pointermove', 300, 300);
    expect(onRectChange).toHaveBeenCalledTimes(calls);
  });

  it('does not move when the drag starts on the close button', () => {
    const onRectChange = vi.fn();
    const el = renderWindow({ onRectChange });

    fire(closeButtonOf(el), 'pointerdown', 200, 100);
    fire(headerOf(el), 'pointermove', 300, 300);

    expect(onRectChange).not.toHaveBeenCalled();
  });

  it('draws eight resize handles, one per edge and corner', () => {
    const el = renderWindow();
    const edges = [
      ...el.querySelectorAll<HTMLElement>(
        '[data-slot="floating-window-resize"]',
      ),
    ].map((handle) => handle.dataset.edge);

    expect(edges.sort()).toEqual(
      ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].sort(),
    );
  });

  it('grows the window from its bottom-right corner on an se-resize', () => {
    const onRectChange = vi.fn();
    const el = renderWindow({ onRectChange });
    const handle = handleOf(el, 'se');

    fire(handle, 'pointerdown', 500, 350);
    fire(handle, 'pointermove', 560, 400);

    expect(onRectChange).toHaveBeenLastCalledWith({
      x: 100,
      y: 50,
      width: 460,
      height: 350,
    });
  });

  it('keeps the right edge on a w-resize and never goes below the minimum width', () => {
    const onRectChange = vi.fn();
    const el = renderWindow({ onRectChange });
    const handle = handleOf(el, 'w');

    fire(handle, 'pointerdown', 100, 200);
    fire(handle, 'pointermove', 50, 200);
    expect(onRectChange).toHaveBeenLastCalledWith({
      x: 50,
      y: 50,
      width: 450,
      height: 300,
    });

    fire(handle, 'pointermove', 300, 200);
    expect(onRectChange).toHaveBeenLastCalledWith({
      x: 180,
      y: 50,
      width: 320,
      height: 300,
    });
  });

  it('stops an e-resize at the container edge', () => {
    const onRectChange = vi.fn();
    const el = renderWindow({ onRectChange });
    const handle = handleOf(el, 'e');

    fire(handle, 'pointerdown', 500, 200);
    fire(handle, 'pointermove', 1800, 200);

    expect(onRectChange).toHaveBeenLastCalledWith({
      x: 100,
      y: 50,
      width: 900,
      height: 300,
    });
  });

  it('calls onFocus on a press anywhere in the window', () => {
    const onFocus = vi.fn();
    const el = renderWindow({ onFocus });

    fire(el.querySelector('p')!, 'pointerdown', 200, 200);
    fire(headerOf(el), 'pointerdown', 200, 100);

    expect(onFocus).toHaveBeenCalledTimes(2);
  });

  it('calls onClose from the × button', () => {
    const onClose = vi.fn();
    const el = renderWindow({ onClose });

    act(() => closeButtonOf(el).click());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('draws no resize handles and does not drag when full-screen', () => {
    const onRectChange = vi.fn();
    const el = renderWindow({ fullScreen: true, onRectChange });

    expect(
      el.querySelectorAll('[data-slot="floating-window-resize"]'),
    ).toHaveLength(0);

    fire(headerOf(el), 'pointerdown', 200, 100);
    fire(headerOf(el), 'pointermove', 300, 300);

    expect(onRectChange).not.toHaveBeenCalled();
  });
});

describe('FloatingWindow — staying reachable', () => {
  it('draws a window inside bounds that shrank under it, without rewriting its stored rect', () => {
    const onRectChange = vi.fn();
    const el = renderWindow({
      rect: { x: 600, y: 400, width: 460, height: 560 },
      bounds: { width: 700, height: 600 },
      onRectChange,
    });

    const box = el.querySelector<HTMLElement>(
      '[data-slot="floating-window"]',
    )!.style;
    expect([box.left, box.top, box.width, box.height]).toEqual([
      '240px',
      '40px',
      '460px',
      '560px',
    ]);
    expect(onRectChange).not.toHaveBeenCalled();
  });

  it('follows the finger that started a drag and ignores a second one', () => {
    const onRectChange = vi.fn();
    const el = renderWindow({ onRectChange });
    const header = headerOf(el);

    fire(header, 'pointerdown', 200, 60, 1);
    fire(header, 'pointerdown', 500, 60, 2);
    fire(header, 'pointermove', 900, 300, 2);
    expect(onRectChange).not.toHaveBeenCalled();

    fire(header, 'pointermove', 220, 70, 1);
    expect(onRectChange).toHaveBeenLastCalledWith({
      ...START,
      x: START.x + 20,
      y: START.y + 10,
    });
  });
});
