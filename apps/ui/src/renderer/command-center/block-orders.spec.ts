// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BLOCK_ORDERS_KEY,
  type BlockOrders,
  type BlockOrdersStore,
  orderedWithin,
  prunedOrders,
  useBlockOrders,
} from './block-orders';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let latest: BlockOrdersStore;
let root: Root;
let container: HTMLDivElement;

function Probe(): null {
  latest = useBlockOrders();
  return null;
}

function mount(): void {
  act(() => {
    root.render(createElement(Probe));
  });
}

function storedOrders(): unknown {
  return JSON.parse(localStorage.getItem(BLOCK_ORDERS_KEY) ?? 'null');
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

describe('orderedWithin — the order of the threads in one block', () => {
  it('stands the threads in the automatic order while no order is stored', () => {
    expect(orderedWithin(['a', 'b', 'c'], undefined)).toEqual(['a', 'b', 'c']);
  });

  it('stands the threads in the order the user stored', () => {
    expect(orderedWithin(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('joins a new thread before the first named thread the automatic order puts after it, else at the end', () => {
    expect(orderedWithin(['a', 'b', 'c'], ['c', 'a'])).toEqual(['b', 'c', 'a']);
    expect(orderedWithin(['a', 'b', 'c'], ['b', 'a'])).toEqual(['b', 'a', 'c']);
  });

  it('drops the stored threads the automatic order no longer has', () => {
    expect(orderedWithin(['a', 'b'], ['x', 'b', 'a'])).toEqual(['b', 'a']);
  });
});

describe('prunedOrders — the orders of threads still on the board', () => {
  it('drops the threads that left the board, and a block left with none', () => {
    expect(
      prunedOrders(
        { 'block:p1': ['r1', 'r2'], 'block:p2': ['r3'] },
        new Set(['r1', 'r4']),
      ),
    ).toEqual({ 'block:p1': ['r1'] });
  });

  it('returns the same object when every stored thread is still on the board', () => {
    const orders: BlockOrders = { 'block:p1': ['r1', 'r2'] };

    expect(prunedOrders(orders, new Set(['r1', 'r2']))).toBe(orders);
  });
});

describe('useBlockOrders — the orders the user set, kept on this device', () => {
  it('orders a block’s threads under its id, and keeps the order on this device', () => {
    mount();

    act(() => latest.order('block:p1', ['r2', 'r1']));

    expect(latest.orders).toEqual({ 'block:p1': ['r2', 'r1'] });
    expect(storedOrders()).toEqual({ 'block:p1': ['r2', 'r1'] });
  });

  it('starts from the orders this device remembers', () => {
    localStorage.setItem(
      BLOCK_ORDERS_KEY,
      JSON.stringify({ 'block:p1': ['r2', 'r1'] }),
    );

    mount();

    expect(latest.orders).toEqual({ 'block:p1': ['r2', 'r1'] });
  });

  it('keeps a block’s order when the page mounts again', () => {
    mount();
    act(() => latest.order('block:p1', ['r2', 'r1']));
    act(() => {
      root.unmount();
    });
    root = createRoot(container);

    mount();

    expect(latest.orders).toEqual({ 'block:p1': ['r2', 'r1'] });
  });

  it('forgets the orders of threads that left the board, and keeps the rest on this device', () => {
    mount();
    act(() => latest.order('block:p1', ['r1', 'r2']));
    act(() => latest.order('block:p2', ['r3']));

    act(() => latest.keepOnly(new Set(['r1', 'r2'])));

    expect(latest.orders).toEqual({ 'block:p1': ['r1', 'r2'] });
    expect(storedOrders()).toEqual({ 'block:p1': ['r1', 'r2'] });
  });

  it('gives every block back its automatic order on reset, and stores none', () => {
    mount();
    act(() => latest.order('block:p1', ['r2', 'r1']));

    act(() => latest.reset());

    expect(latest.orders).toEqual({});
    expect(storedOrders()).toEqual({});
  });
});
