// @vitest-environment jsdom
import { ReactFlowProvider } from '@xyflow/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bareThreadIdentity } from '../components/thread-head';
import type { PlacedBox } from './graph-layout';
import type { CardSize } from './open-cards';
import {
  type CanvasCard,
  clampCard,
  largestCard,
  PhoneThreadCard,
  resizeCard,
  ThreadCardLayer,
  type ThreadCardLayerProps,
} from './thread-card-layer';

const { usePhoneBackEntryMock } = vi.hoisted(() => ({
  usePhoneBackEntryMock: vi.fn(),
}));
vi.mock('../components/use-phone-back-entry', () => ({
  usePhoneBackEntry: usePhoneBackEntryMock,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LARGEST: CardSize = { width: 900, height: 600 };
const ORIGIN: CardSize = { width: 400, height: 300 };

describe('resizeCard', () => {
  it('a drag from the bottom edge changes only the height', () => {
    expect(resizeCard(ORIGIN, 's', { dx: 200, dy: 50 }, LARGEST)).toEqual({
      width: 400,
      height: 350,
    });
  });

  it('a drag from the corner changes both the width and the height', () => {
    expect(resizeCard(ORIGIN, 'se', { dx: 60, dy: -40 }, LARGEST)).toEqual({
      width: 460,
      height: 260,
    });
  });

  it('never takes a card below the smallest it may be', () => {
    expect(resizeCard(ORIGIN, 'se', { dx: -1000, dy: -1000 }, LARGEST)).toEqual(
      { width: 320, height: 220 },
    );
  });

  it('never takes a card past the largest it may be', () => {
    expect(resizeCard(ORIGIN, 'se', { dx: 5000, dy: 5000 }, LARGEST)).toEqual(
      LARGEST,
    );
  });
});

describe('clampCard', () => {
  it('holds each side between the smallest card and the largest', () => {
    expect(clampCard({ width: 100, height: 9999 }, LARGEST)).toEqual({
      width: 320,
      height: 600,
    });
  });
});

describe('largestCard', () => {
  it('is as big as the pane less its inset and the card head', () => {
    expect(largestCard({ width: 1000, height: 800 })).toEqual({
      width: 968,
      height: 702,
    });
  });

  it('is never smaller than the smallest card', () => {
    expect(largestCard({ width: 200, height: 100 })).toEqual({
      width: 320,
      height: 220,
    });
  });
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
  usePhoneBackEntryMock.mockImplementation(
    (_owner: string, _open: boolean, onBack: () => void) => () => onBack(),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  usePhoneBackEntryMock.mockReset();
});

function card(runId: string, width: number, height: number): CanvasCard {
  return {
    runId,
    identity: bareThreadIdentity(`Thread ${runId}`),
    attention: 'working',
    size: { width, height },
  };
}

function box(x: number, y: number): PlacedBox {
  return { id: 'thread:a', x, y, width: 460, height: 486 };
}

function layerProps(
  over: Partial<ThreadCardLayerProps> = {},
): ThreadCardLayerProps {
  return {
    cards: [card('a', 400, 300)],
    slots: new Map([['a', box(0, 0)]]),
    pane: { width: 1000, height: 800 },
    flashing: null,
    onClose: vi.fn(),
    onResize: vi.fn(),
    onOpenInChats: vi.fn(),
    renderChat: (runId) => (
      <span data-slot="card-chat">{`chat of ${runId}`}</span>
    ),
    ...over,
  };
}

function drawLayer(over: Partial<ThreadCardLayerProps> = {}): void {
  act(() => {
    root.render(
      <ReactFlowProvider>
        <ThreadCardLayer {...layerProps(over)} />
      </ReactFlowProvider>,
    );
  });
}

function pointer(type: string, clientX: number, clientY: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
}

function handleOf(edge: 's' | 'se'): HTMLElement {
  return container.querySelector<HTMLElement>(
    `[data-slot="thread-canvas-card-resize"][data-edge="${edge}"]`,
  )!;
}

describe('ThreadCardLayer — the cards over the canvas', () => {
  it('draws one card per open thread that has a slot, each with its chat, and none for one without', () => {
    drawLayer({
      cards: [card('a', 400, 300), card('b', 400, 300)],
      slots: new Map([['a', box(0, 0)]]),
    });

    const cards = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-slot="thread-canvas-card"]',
      ),
    );
    expect(cards.map((el) => el.dataset.runId)).toEqual(['a']);
    expect(
      cards[0]!.querySelector('[data-slot="card-chat"]')!.textContent,
    ).toBe('chat of a');
  });

  it('draws no layer when no open thread has a slot', () => {
    drawLayer({ slots: new Map() });

    expect(
      container.querySelector('[data-slot="command-center-cards"]'),
    ).toBeNull();
  });

  it('resizes from the corner, handing the new size up once on release', () => {
    const onResize = vi.fn();
    drawLayer({ onResize });

    act(() => {
      handleOf('se').dispatchEvent(pointer('pointerdown', 100, 100));
    });
    act(() => {
      handleOf('se').dispatchEvent(pointer('pointermove', 160, 140));
    });
    expect(onResize).not.toHaveBeenCalled();
    act(() => {
      handleOf('se').dispatchEvent(pointer('pointerup', 160, 140));
    });

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith('a', { width: 460, height: 340 });
  });

  it('resizes from the bottom edge, changing the height alone', () => {
    const onResize = vi.fn();
    drawLayer({ onResize });

    act(() => {
      handleOf('s').dispatchEvent(pointer('pointerdown', 100, 100));
    });
    act(() => {
      handleOf('s').dispatchEvent(pointer('pointermove', 300, 150));
    });
    act(() => {
      handleOf('s').dispatchEvent(pointer('pointerup', 300, 150));
    });

    expect(onResize).toHaveBeenCalledWith('a', { width: 400, height: 350 });
  });

  it('hides the chat from its head icon, which closes the card of that thread', () => {
    const onClose = vi.fn();
    drawLayer({ onClose });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-slot="thread-head-hide-chat"]',
        )!
        .click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('a');
  });

  it('takes the thread to Chats from its head icon', () => {
    const onOpenInChats = vi.fn();
    drawLayer({ onOpenInChats });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-slot="thread-head-open-in-chats"]',
        )!
        .click();
    });

    expect(onOpenInChats).toHaveBeenCalledWith('a');
  });
});

describe('PhoneThreadCard — the open thread on a phone', () => {
  function drawPhone(
    over: {
      onClose?: () => void;
      onOpenInChats?: () => void;
    } = {},
  ): void {
    act(() => {
      root.render(
        <PhoneThreadCard
          card={card('a', 400, 300)}
          active
          onClose={over.onClose ?? vi.fn()}
          onOpenInChats={over.onOpenInChats ?? vi.fn()}
          chat={<span data-slot="card-chat">chat of a</span>}
        />,
      );
    });
  }

  it('the back button closes the card through the page’s back entry', () => {
    const onClose = vi.fn();
    drawPhone({ onClose });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-slot="thread-phone-card-back"]',
        )!
        .click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(usePhoneBackEntryMock).toHaveBeenCalledWith(
      'command-center-card',
      true,
      onClose,
    );
  });

  it('takes the thread to Chats from its head, and draws no hide icon', () => {
    const onOpenInChats = vi.fn();
    drawPhone({ onOpenInChats });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-slot="thread-head-open-in-chats"]',
        )!
        .click();
    });

    expect(onOpenInChats).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-slot="thread-head-hide-chat"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="card-chat"]')!.textContent,
    ).toBe('chat of a');
  });
});
