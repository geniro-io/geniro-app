// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readSwipe,
  SWIPE_MIN_DISTANCE_PX,
  type SwipeHandler,
  useSwipeGesture,
} from './use-swipe-gesture';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom has no `Touch` constructor, so a touch is an ordinary event carrying
 * the three fields the hook reads. `timeStamp` is a prototype getter, which an
 * own property shadows.
 */
function touch(
  type: 'touchstart' | 'touchend',
  target: EventTarget,
  point: { x: number; y: number },
  at: number,
  fingers = 1,
): void {
  const event = new Event(type, { bubbles: true });
  const list = Array.from({ length: fingers }, () => ({
    clientX: point.x,
    clientY: point.y,
  }));
  Object.defineProperty(event, 'touches', {
    value: type === 'touchstart' ? list : [],
  });
  Object.defineProperty(event, 'changedTouches', { value: list });
  Object.defineProperty(event, 'timeStamp', { value: at });
  target.dispatchEvent(event);
}

function swipe(
  target: EventTarget,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  touch('touchstart', target, from, 1000);
  touch('touchend', target, to, 1200);
}

const RIGHT = { from: { x: 100, y: 300 }, to: { x: 220, y: 310 } };
const LEFT = { from: { x: 250, y: 300 }, to: { x: 120, y: 290 } };

function Probe({
  handler,
  enabled,
  priority,
}: {
  handler: SwipeHandler;
  enabled?: boolean;
  priority?: number;
}): null {
  useSwipeGesture(handler, { enabled, priority });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('innerWidth', 390);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('readSwipe', () => {
  const at = (x: number, y: number, t: number) => ({ x, y, at: t });
  const from = { ...at(100, 300, 0), target: null };

  it('reads a long, fast, mostly horizontal travel as a swipe each way', () => {
    expect(readSwipe(from, at(200, 310, 300), 390)).toBe('right');
    expect(readSwipe(from, at(25, 290, 300), 390)).toBe('left');
  });

  it('ignores a short drift, a scroll and a slow drag', () => {
    expect(
      readSwipe(from, at(100 + SWIPE_MIN_DISTANCE_PX - 1, 300, 300), 390),
    ).toBeNull();
    // 80px across, 60px down: a diagonal scroll, not a swipe.
    expect(readSwipe(from, at(180, 360, 300), 390)).toBeNull();
    expect(readSwipe(from, at(220, 300, 2000), 390)).toBeNull();
  });

  it('leaves a swipe starting at either screen edge to the browser', () => {
    expect(
      readSwipe({ ...at(5, 300, 0), target: null }, at(200, 300, 300), 390),
    ).toBeNull();
    expect(
      readSwipe({ ...at(385, 300, 0), target: null }, at(200, 300, 300), 390),
    ).toBeNull();
  });
});

describe('useSwipeGesture', () => {
  it('hands a swipe to the handler with its direction', () => {
    const handler = vi.fn(() => true);
    act(() => root.render(<Probe handler={handler} />));

    swipe(document.body, RIGHT.from, RIGHT.to);
    swipe(document.body, LEFT.from, LEFT.to);

    expect(handler.mock.calls).toEqual([['right'], ['left']]);
  });

  it('asks the highest priority first and stops at the first that acts', () => {
    const order: string[] = [];
    const low = vi.fn(() => {
      order.push('low');
      return true;
    });
    const high = vi.fn(() => {
      order.push('high');
      return true;
    });
    act(() =>
      root.render(
        <>
          <Probe handler={low} priority={0} />
          <Probe handler={high} priority={20} />
        </>,
      ),
    );

    swipe(document.body, RIGHT.from, RIGHT.to);

    expect(order).toEqual(['high']);
    expect(low).not.toHaveBeenCalled();
  });

  it('passes a swipe on when a handler declines it', () => {
    const low = vi.fn(() => true);
    const high = vi.fn(() => false);
    act(() =>
      root.render(
        <>
          <Probe handler={low} priority={0} />
          <Probe handler={high} priority={20} />
        </>,
      ),
    );

    swipe(document.body, RIGHT.from, RIGHT.to);

    expect(high).toHaveBeenCalledWith('right');
    expect(low).toHaveBeenCalledWith('right');
  });

  it('does nothing while disabled, or once unmounted', () => {
    const handler = vi.fn(() => true);
    act(() => root.render(<Probe handler={handler} enabled={false} />));
    swipe(document.body, RIGHT.from, RIGHT.to);
    expect(handler).not.toHaveBeenCalled();

    act(() => root.render(<Probe handler={handler} />));
    act(() => root.render(<></>));
    swipe(document.body, RIGHT.from, RIGHT.to);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores a swipe that starts in a text field or a dialog', () => {
    const handler = vi.fn(() => true);
    act(() => root.render(<Probe handler={handler} />));
    const field = document.createElement('textarea');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inside = document.createElement('span');
    dialog.appendChild(inside);
    document.body.append(field, dialog);

    swipe(field, RIGHT.from, RIGHT.to);
    swipe(inside, RIGHT.from, RIGHT.to);

    expect(handler).not.toHaveBeenCalled();
    field.remove();
    dialog.remove();
  });

  it('ignores a pinch — a second finger voids the swipe', () => {
    const handler = vi.fn(() => true);
    act(() => root.render(<Probe handler={handler} />));

    touch('touchstart', document.body, RIGHT.from, 1000, 2);
    touch('touchend', document.body, RIGHT.to, 1200);

    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves the swipe to a wide block that can still scroll that way', () => {
    const handler = vi.fn(() => true);
    act(() => root.render(<Probe handler={handler} />));
    const scroller = document.createElement('pre');
    scroller.style.overflowX = 'auto';
    Object.defineProperty(scroller, 'scrollWidth', { value: 800 });
    Object.defineProperty(scroller, 'clientWidth', { value: 300 });
    const line = document.createElement('code');
    scroller.appendChild(line);
    document.body.appendChild(scroller);

    // At its start: a left swipe scrolls the block, a right one has nowhere
    // to scroll it and is the shell's.
    swipe(line, LEFT.from, LEFT.to);
    expect(handler).not.toHaveBeenCalled();
    swipe(line, RIGHT.from, RIGHT.to);
    expect(handler).toHaveBeenCalledWith('right');

    scroller.remove();
  });
});
