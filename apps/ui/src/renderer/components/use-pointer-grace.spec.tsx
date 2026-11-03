// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  POINTER_GRACE_MS,
  type PointerGrace,
  usePointerGrace,
} from './use-pointer-grace';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let panel: HTMLDivElement;
let inPanel: HTMLSpanElement;
let trigger: HTMLButtonElement;
let grace: PointerGrace;

function Probe(): null {
  grace = usePointerGrace();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  panel = document.createElement('div');
  panel.getBoundingClientRect = () =>
    ({
      left: 100,
      right: 300,
      top: 50,
      bottom: 250,
      width: 200,
      height: 200,
    }) as DOMRect;
  inPanel = document.createElement('span');
  panel.appendChild(inPanel);
  trigger = document.createElement('button');
  document.body.append(panel, trigger);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe />);
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  panel.remove();
  trigger.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

const leave = (
  target: EventTarget,
  x: number,
  y: number,
): { clientX: number; clientY: number; target: EventTarget } => ({
  clientX: x,
  clientY: y,
  target,
});

const moveTo = (x: number, y: number): void => {
  document.dispatchEvent(
    new MouseEvent('mousemove', { clientX: x, clientY: y }),
  );
};

describe('usePointerGrace', () => {
  it('holds while the pointer heads for the panel, and lapses once the time is up', () => {
    const onLapse = vi.fn();
    grace.start(leave(trigger, 90, 20), panel, onLapse);

    moveTo(150, 40);
    vi.advanceTimersByTime(POINTER_GRACE_MS - 1);
    expect(onLapse).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLapse).toHaveBeenCalledTimes(1);
  });

  it('lapses at once when the pointer strays from the way to the panel', () => {
    const onLapse = vi.fn();
    grace.start(leave(trigger, 90, 20), panel, onLapse);

    moveTo(20, 20);

    expect(onLapse).toHaveBeenCalledTimes(1);
  });

  it('ends without lapsing once the pointer reaches the panel', () => {
    const onLapse = vi.fn();
    grace.start(leave(trigger, 90, 20), panel, onLapse);

    moveTo(150, 60);
    vi.advanceTimersByTime(POINTER_GRACE_MS * 2);
    moveTo(20, 20);

    expect(onLapse).not.toHaveBeenCalled();
  });

  it('waits out the time when the pointer leaves the panel itself, wherever it goes', () => {
    const onLapse = vi.fn();
    grace.start(leave(inPanel, 305, 100), panel, onLapse);

    moveTo(400, 100);
    expect(onLapse).not.toHaveBeenCalled();

    vi.advanceTimersByTime(POINTER_GRACE_MS);
    expect(onLapse).toHaveBeenCalledTimes(1);
  });

  it('lapses at once when there is no panel to reach', () => {
    const onLapse = vi.fn();
    grace.start(leave(trigger, 90, 20), null, onLapse);

    expect(onLapse).toHaveBeenCalledTimes(1);
  });

  it('says whether a point is on the way to the panel, and nothing once stopped', () => {
    grace.start(leave(trigger, 90, 20), panel, () => {});

    expect(grace.covers({ x: 150, y: 40 })).toBe(true);
    expect(grace.covers({ x: 20, y: 20 })).toBe(false);

    grace.stop();
    expect(grace.covers({ x: 150, y: 40 })).toBe(false);
  });

  it('leaves no timer and no listener behind on unmount', () => {
    const onLapse = vi.fn();
    grace.start(leave(trigger, 90, 20), panel, onLapse);

    act(() => {
      root!.unmount();
    });
    root = null;
    moveTo(20, 20);

    expect(vi.getTimerCount()).toBe(0);
    expect(onLapse).not.toHaveBeenCalled();
  });
});
