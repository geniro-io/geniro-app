// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_REMEMBERED_NODE_POSITIONS,
  NODE_POSITIONS_KEY,
  type NodeOffset,
  type NodePositions,
  readNodePositions,
  useNodePositions,
} from './node-positions';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OFFSET: NodeOffset = { x: 120, y: 240 };
const OTHER: NodeOffset = { x: -40, y: 16 };

let latest: NodePositions;
let root: Root;
let container: HTMLDivElement;

function Probe(): null {
  latest = useNodePositions();
  return null;
}

function mount(): void {
  act(() => {
    root.render(createElement(Probe));
  });
}

function storedPositions(): unknown {
  return JSON.parse(localStorage.getItem(NODE_POSITIONS_KEY) ?? 'null');
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  localStorage.clear();
});

describe('useNodePositions — the places nodes were dragged to', () => {
  it('places a node under its thread id, and keeps the place on this device', () => {
    mount();

    act(() => latest.place('a', OFFSET));

    expect(latest.offsets).toEqual({ a: OFFSET });
    expect(storedPositions()).toEqual({ a: OFFSET });
  });

  it('starts from the places this device remembers', () => {
    localStorage.setItem(NODE_POSITIONS_KEY, JSON.stringify({ a: OFFSET }));

    mount();

    expect(latest.offsets).toEqual({ a: OFFSET });
  });

  it('reads only well-formed places, and none from a value that is not an object', () => {
    localStorage.setItem(
      NODE_POSITIONS_KEY,
      JSON.stringify({
        good: OFFSET,
        text: { x: 'left', y: 1 },
        partial: { x: 3 },
        empty: { x: 1, y: null },
        nothing: null,
        list: [1, 2],
      }),
    );
    expect(readNodePositions()).toEqual({ good: OFFSET });

    localStorage.setItem(NODE_POSITIONS_KEY, '{not json');
    expect(readNodePositions()).toEqual({});

    localStorage.setItem(NODE_POSITIONS_KEY, 'null');
    expect(readNodePositions()).toEqual({});

    localStorage.setItem(NODE_POSITIONS_KEY, '"text"');
    expect(readNodePositions()).toEqual({});
  });

  it('forgets the places of threads that left the board, and keeps the rest on this device', () => {
    mount();
    act(() => latest.place('a', OFFSET));
    act(() => latest.place('b', OTHER));

    act(() => latest.keepOnly(new Set(['a'])));

    expect(latest.offsets).toEqual({ a: OFFSET });
    expect(storedPositions()).toEqual({ a: OFFSET });
  });

  it('writes nothing when every thread on the board still has its place', () => {
    const stored = '{ "a": { "x": 120, "y": 240 } }';
    localStorage.setItem(NODE_POSITIONS_KEY, stored);
    mount();

    act(() => latest.keepOnly(new Set(['a', 'b'])));

    expect(latest.offsets).toEqual({ a: OFFSET });
    expect(localStorage.getItem(NODE_POSITIONS_KEY)).toBe(stored);
  });

  it('gives one thread’s node back to the automatic layout, and keeps the rest on this device', () => {
    mount();
    act(() => latest.place('a', OFFSET));
    act(() => latest.place('b', OTHER));

    act(() => latest.forget('a'));

    expect(latest.offsets).toEqual({ b: OTHER });
    expect(storedPositions()).toEqual({ b: OTHER });
  });

  it('leaves the places as they are when the thread has none', () => {
    const stored = '{ "a": { "x": 120, "y": 240 } }';
    localStorage.setItem(NODE_POSITIONS_KEY, stored);
    mount();
    const before = latest.offsets;

    act(() => latest.forget('unknown'));

    expect(latest.offsets).toBe(before);
    expect(localStorage.getItem(NODE_POSITIONS_KEY)).toBe(stored);
  });

  it('gives every node back to the automatic layout on reset, and stores no place', () => {
    mount();
    act(() => latest.place('a', OFFSET));
    act(() => latest.place('b', OTHER));

    act(() => latest.reset());

    expect(latest.offsets).toEqual({});
    expect(storedPositions()).toEqual({});
  });

  it('keeps the most recent places, dropping the oldest past the cap', () => {
    const places: Record<string, NodeOffset> = {};
    for (let index = 0; index < MAX_REMEMBERED_NODE_POSITIONS; index += 1) {
      places[`r${index}`] = OFFSET;
    }
    localStorage.setItem(NODE_POSITIONS_KEY, JSON.stringify(places));
    mount();

    act(() => latest.place('new', OTHER));

    const kept = Object.keys(latest.offsets);
    expect(kept).toHaveLength(MAX_REMEMBERED_NODE_POSITIONS);
    expect(kept).not.toContain('r0');
    expect(kept).toContain('r1');
    expect(kept.at(-1)).toBe('new');
    expect(Object.keys(storedPositions() as object)).toHaveLength(
      MAX_REMEMBERED_NODE_POSITIONS,
    );
  });
});
