// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BLOCK_PLACES_KEY,
  blockIdOf,
  type BlockPlacesStore,
  NO_PROJECT_BLOCK,
  useBlockPlaces,
} from './block-places';
import type { NodeOffset } from './node-positions';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OFFSET: NodeOffset = { x: 120, y: 240 };
const OTHER: NodeOffset = { x: -40, y: 16 };

let latest: BlockPlacesStore;
let root: Root;
let container: HTMLDivElement;

function Probe(): null {
  latest = useBlockPlaces();
  return null;
}

function mount(): void {
  act(() => {
    root.render(createElement(Probe));
  });
}

function storedPlaces(): unknown {
  return JSON.parse(localStorage.getItem(BLOCK_PLACES_KEY) ?? 'null');
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

describe('blockIdOf — the block a thread stands in', () => {
  it('gives a thread of a project the block of that project', () => {
    expect(blockIdOf({ projectId: 'project-billing' })).toBe(
      'block:project-billing',
    );
  });

  it('gives a thread of no project the block of no project', () => {
    expect(blockIdOf({ projectId: null })).toBe(NO_PROJECT_BLOCK);
  });
});

describe('useBlockPlaces — the places project blocks were moved to', () => {
  it('places a block under its id, and keeps the place on this device', () => {
    mount();

    act(() => latest.place('block:a', OFFSET));

    expect(latest.places).toEqual({ 'block:a': OFFSET });
    expect(storedPlaces()).toEqual({ 'block:a': OFFSET });
  });

  it('starts from the places this device remembers', () => {
    localStorage.setItem(
      BLOCK_PLACES_KEY,
      JSON.stringify({ 'block:a': OFFSET }),
    );

    mount();

    expect(latest.places).toEqual({ 'block:a': OFFSET });
  });

  it('forgets the places of blocks with no thread on the board, and keeps the rest on this device', () => {
    mount();
    act(() => latest.place('block:a', OFFSET));
    act(() => latest.place('block:b', OTHER));

    act(() => latest.keepOnly(new Set(['block:a'])));

    expect(latest.places).toEqual({ 'block:a': OFFSET });
    expect(storedPlaces()).toEqual({ 'block:a': OFFSET });
  });

  it('gives every block back its automatic place on reset, and stores none', () => {
    mount();
    act(() => latest.place('block:a', OFFSET));
    act(() => latest.place('block:b', OTHER));

    act(() => latest.reset());

    expect(latest.places).toEqual({});
    expect(storedPlaces()).toEqual({});
  });
});
