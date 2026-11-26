// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CARD_SIZES_KEY,
  type CardBand,
  type CardSize,
  DEFAULT_CARD_SIZE,
  MAX_REMEMBERED_CARD_SIZES,
  type OpenCards,
  readCardSizes,
  useOpenCards,
  withCardSize,
} from './open-cards';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BAND: CardBand = {
  attention: 'working',
  lastAt: '2026-11-17T12:00:00.000Z',
};
const OTHER_BAND: CardBand = {
  attention: 'blocked',
  lastAt: '2026-11-17T11:00:00.000Z',
};
const SIZE: CardSize = { width: 500, height: 300 };
const OTHER_SIZE: CardSize = { width: 380, height: 240 };

let latest: OpenCards;
let root: Root;
let container: HTMLDivElement;

function Probe({ narrow }: { narrow: boolean }): null {
  latest = useOpenCards(narrow);
  return null;
}

function mount(narrow = false): void {
  act(() => {
    root.render(createElement(Probe, { narrow }));
  });
}

function storedSizes(): unknown {
  return JSON.parse(localStorage.getItem(CARD_SIZES_KEY) ?? 'null');
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

describe('useOpenCards — which threads stand open', () => {
  it('opens threads as cards in the order they opened, each with its band', () => {
    mount();

    act(() => latest.open('a', BAND));
    act(() => latest.open('b', OTHER_BAND));

    expect(latest.cards).toEqual([
      { runId: 'a', band: BAND, aboveWindow: false },
      { runId: 'b', band: OTHER_BAND, aboveWindow: false },
    ]);
    expect(latest.isOpen('a')).toBe(true);
  });

  it('closes a card, and toggles one shut and open again', () => {
    mount();
    act(() => latest.open('a', BAND));

    act(() => latest.close('a'));
    expect(latest.cards).toEqual([]);
    expect(latest.isOpen('a')).toBe(false);

    act(() => latest.toggle('a', BAND));
    expect(latest.isOpen('a')).toBe(true);
    act(() => latest.toggle('a', BAND));
    expect(latest.isOpen('a')).toBe(false);
  });

  it('keeps a card’s first band when its thread is opened again', () => {
    mount();

    act(() => latest.open('a', BAND));
    act(() => latest.open('a', OTHER_BAND));

    expect(latest.cards).toEqual([
      { runId: 'a', band: BAND, aboveWindow: false },
    ]);
  });

  it('keeps a card over the manager’s window from its first open there until it closes', () => {
    mount();

    act(() => latest.open('a', BAND));
    act(() => latest.open('a', BAND, true));
    act(() => latest.open('a', BAND));
    expect(latest.cards).toEqual([
      { runId: 'a', band: BAND, aboveWindow: true },
    ]);

    act(() => latest.close('a'));
    act(() => latest.toggle('a', BAND));
    expect(latest.cards).toEqual([
      { runId: 'a', band: BAND, aboveWindow: false },
    ]);
  });

  it('on a phone keeps only the card opened last', () => {
    mount(true);

    act(() => latest.open('a', BAND));
    act(() => latest.open('b', BAND));

    expect(latest.cards.map((card) => card.runId)).toEqual(['b']);
  });

  it('closes the cards of threads that left the board, and forgets their sizes', () => {
    mount();
    act(() => latest.open('a', BAND));
    act(() => latest.open('b', BAND));
    act(() => latest.resize('b', SIZE));

    act(() => latest.keepOnly(new Set(['a'])));

    expect(latest.cards.map((card) => card.runId)).toEqual(['a']);
    expect(latest.sizeOf('b')).toEqual(DEFAULT_CARD_SIZE);
    expect(storedSizes()).toEqual({});
  });
});

describe('useOpenCards — card sizes', () => {
  it('remembers the size a card was left at on this device and hands it back', () => {
    mount();

    act(() => latest.resize('a', SIZE));

    expect(latest.sizeOf('a')).toEqual(SIZE);
    expect(storedSizes()).toEqual({ a: SIZE });
  });

  it('gives a thread with no remembered size the default size', () => {
    mount();

    expect(latest.sizeOf('a')).toEqual(DEFAULT_CARD_SIZE);
  });

  it('starts from the sizes this device remembers', () => {
    localStorage.setItem(CARD_SIZES_KEY, JSON.stringify({ a: SIZE }));

    mount();

    expect(latest.sizeOf('a')).toEqual(SIZE);
  });

  it('reads only well-formed sizes, and no sizes from a value that is not an object', () => {
    localStorage.setItem(
      CARD_SIZES_KEY,
      JSON.stringify({
        good: SIZE,
        wide: { width: 'wide', height: 300 },
        partial: { width: 400 },
        empty: { width: 400, height: null },
        nothing: null,
      }),
    );
    expect(readCardSizes()).toEqual({ good: SIZE });

    localStorage.setItem(CARD_SIZES_KEY, '{not json');
    expect(readCardSizes()).toEqual({});

    localStorage.setItem(CARD_SIZES_KEY, 'null');
    expect(readCardSizes()).toEqual({});

    localStorage.setItem(CARD_SIZES_KEY, '"text"');
    expect(readCardSizes()).toEqual({});
  });

  it('keeps the most recent sizes, dropping the oldest past the cap', () => {
    const sizes: Record<string, CardSize> = {};
    for (let index = 0; index < MAX_REMEMBERED_CARD_SIZES; index += 1) {
      sizes[`r${index}`] = SIZE;
    }

    const next = withCardSize(sizes, 'new', OTHER_SIZE);

    expect(Object.keys(next)).toHaveLength(MAX_REMEMBERED_CARD_SIZES);
    expect(next).not.toHaveProperty('r0');
    expect(next).toHaveProperty('r1');
    expect(Object.keys(next).at(-1)).toBe('new');
  });

  it('moves a re-sized thread to the most recent place without dropping another', () => {
    const sizes: Record<string, CardSize> = {};
    for (let index = 0; index < MAX_REMEMBERED_CARD_SIZES; index += 1) {
      sizes[`r${index}`] = SIZE;
    }

    const next = withCardSize(sizes, 'r0', OTHER_SIZE);

    expect(Object.keys(next)).toHaveLength(MAX_REMEMBERED_CARD_SIZES);
    expect(next).toHaveProperty('r1');
    expect(Object.keys(next).at(-1)).toBe('r0');
    expect(next.r0).toEqual(OTHER_SIZE);
  });
});
