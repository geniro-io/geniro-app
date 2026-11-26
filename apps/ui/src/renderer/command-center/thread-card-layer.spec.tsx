// @vitest-environment jsdom
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ThreadArchiveContext,
  type ThreadArchiveOf,
} from '../components/thread-archive';
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
  ZOOM_SETTLE_MS,
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

  it('a drag from the right edge changes only the width', () => {
    expect(resizeCard(ORIGIN, 'e', { dx: 50, dy: 200 }, LARGEST)).toEqual({
      width: 450,
      height: 300,
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
    aboveWindow: false,
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
    onMove: vi.fn(),
    onOpenInChats: vi.fn(),
    renderChat: (runId) => (
      <span data-slot="card-chat">{`chat of ${runId}`}</span>
    ),
    ...over,
  };
}

let flowStore: ReturnType<typeof useStoreApi> | null = null;

function StoreProbe(): null {
  flowStore = useStoreApi();
  return null;
}

function drawLayer(
  over: Partial<ThreadCardLayerProps> = {},
  archiveOf: ThreadArchiveOf | null = null,
): void {
  act(() => {
    root.render(
      <ThreadArchiveContext.Provider value={archiveOf}>
        <ReactFlowProvider>
          <StoreProbe />
          <ThreadCardLayer {...layerProps(over)} />
        </ReactFlowProvider>
      </ThreadArchiveContext.Provider>,
    );
  });
}

function placedOf(runId: string): HTMLElement {
  return container
    .querySelector<HTMLElement>(
      `[data-slot="thread-canvas-card"][data-run-id="${runId}"]`,
    )!
    .closest<HTMLElement>('[data-slot="thread-canvas-card-place"]')!;
}

function scalerOf(runId: string): HTMLElement {
  return container
    .querySelector<HTMLElement>(
      `[data-slot="thread-canvas-card"][data-run-id="${runId}"]`,
    )!
    .closest<HTMLElement>('[data-slot="thread-canvas-card-zoom"]')!;
}

function flashOf(runId: string): Element | null {
  return container.querySelector(
    `[data-slot="thread-canvas-card"][data-run-id="${runId}"] [data-slot="thread-canvas-card-flash"]`,
  );
}

function pointer(type: string, clientX: number, clientY: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
}

function handleOf(edge: 's' | 'e' | 'se'): HTMLElement {
  return container.querySelector<HTMLElement>(
    `[data-slot="thread-canvas-card-resize"][data-edge="${edge}"]`,
  )!;
}

function headOf(runId: string): HTMLElement {
  return container.querySelector<HTMLElement>(
    `[data-slot="thread-canvas-card"][data-run-id="${runId}"] [data-slot="thread-canvas-card-head"]`,
  )!;
}

describe('ThreadCardLayer — the cards over the canvas', () => {
  it('stands a card under the manager’s window until the cards are put in front, then over it', () => {
    drawLayer();
    expect(placedOf('a').style.zIndex).toBe('20');
    expect(placedOf('a').dataset.overWindow).toBeUndefined();

    drawLayer({ inFront: true });
    expect(placedOf('a').style.zIndex).toBe('35');
    expect(placedOf('a').dataset.overWindow).toBe('true');
  });

  it('stands a card opened from the manager’s window over it whether the other cards are in front or not', () => {
    const cards = [
      { ...card('a', 400, 300), aboveWindow: true },
      card('b', 400, 300),
    ];
    const slots = new Map([
      ['a', box(0, 0)],
      ['b', box(600, 0)],
    ]);
    drawLayer({ cards, slots });
    expect(placedOf('a').style.zIndex).toBe('35');
    expect(placedOf('b').style.zIndex).toBe('20');

    drawLayer({ cards, slots, inFront: true });
    expect(placedOf('a').style.zIndex).toBe('35');
    expect(placedOf('b').style.zIndex).toBe('35');
  });

  it('reports a press inside a card, but not inside one opened from the manager’s window', () => {
    const onActivate = vi.fn();
    drawLayer({
      cards: [
        { ...card('a', 400, 300), aboveWindow: true },
        card('b', 400, 300),
      ],
      slots: new Map([
        ['a', box(0, 0)],
        ['b', box(600, 0)],
      ]),
      onActivate,
    });
    const chatOf = (runId: string): Element =>
      placedOf(runId).querySelector('[data-slot="card-chat"]')!;
    act(() => {
      chatOf('a').dispatchEvent(pointer('pointerdown', 10, 10));
    });
    expect(onActivate).not.toHaveBeenCalled();
    act(() => {
      chatOf('b').dispatchEvent(pointer('pointerdown', 610, 10));
    });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('raises the card pressed last above the others on its side of the window', () => {
    drawLayer({
      cards: [
        { ...card('a', 400, 300), aboveWindow: true },
        card('b', 400, 300),
      ],
      slots: new Map([
        ['a', box(0, 0)],
        ['b', box(600, 0)],
      ]),
      inFront: true,
    });
    act(() => {
      headOf('b').dispatchEvent(pointer('pointerdown', 610, 10));
      headOf('b').dispatchEvent(pointer('pointerup', 610, 10));
    });
    expect(placedOf('b').style.zIndex).toBe('36');
    expect(placedOf('a').style.zIndex).toBe('35');
  });

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

  it("shows the loader in the head of a working thread's card, and of no other attention", () => {
    drawLayer({
      cards: [
        card('a', 400, 300),
        { ...card('b', 400, 300), attention: 'question' },
      ],
      slots: new Map([
        ['a', box(0, 0)],
        ['b', box(500, 0)],
      ]),
    });

    const cardOf = (runId: string): HTMLElement =>
      container.querySelector<HTMLElement>(
        `[data-slot="thread-canvas-card"][data-run-id="${runId}"]`,
      )!;
    const loaderOf = (runId: string): Element | null =>
      cardOf(runId).querySelector(
        '[data-slot="thread-canvas-card-head"] svg.animate-spin',
      );
    expect(loaderOf('a')).not.toBeNull();
    expect(loaderOf('b')).toBeNull();
    expect(cardOf('a').className).not.toContain('cc-running-border');
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

  it('resizes from the right edge, changing the width alone', () => {
    const onResize = vi.fn();
    drawLayer({ onResize });

    act(() => {
      handleOf('e').dispatchEvent(pointer('pointerdown', 100, 100));
    });
    act(() => {
      handleOf('e').dispatchEvent(pointer('pointermove', 150, 300));
    });
    act(() => {
      handleOf('e').dispatchEvent(pointer('pointerup', 150, 300));
    });

    expect(onResize).toHaveBeenCalledWith('a', { width: 450, height: 300 });
  });

  it('measures a resize in card pixels, so at zoom 2 the same screen drag grows the card half as much', () => {
    const onResize = vi.fn();
    drawLayer({ onResize });
    act(() => {
      flowStore!.setState({ transform: [0, 0, 2] });
    });

    act(() => {
      handleOf('se').dispatchEvent(pointer('pointerdown', 100, 100));
    });
    act(() => {
      handleOf('se').dispatchEvent(pointer('pointermove', 160, 140));
    });
    act(() => {
      handleOf('se').dispatchEvent(pointer('pointerup', 160, 140));
    });

    expect(onResize).toHaveBeenCalledWith('a', { width: 430, height: 320 });
  });

  it('shows a grip in the corner that resizes', () => {
    drawLayer();

    expect(
      handleOf('se').querySelector('[data-slot="thread-canvas-card-grip"]'),
    ).not.toBeNull();
    expect(handleOf('se').className).toContain('cursor-nwse-resize');
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

  it('archives the thread of the card whose head icon is pressed, through the action of its run', () => {
    const archive = vi.fn<(runId: string) => void>();
    const archiveOf = vi.fn<ThreadArchiveOf>((runId) => () => archive(runId));
    drawLayer(
      {
        cards: [card('a', 400, 300), card('b', 400, 300)],
        slots: new Map([
          ['a', box(0, 0)],
          ['b', box(500, 0)],
        ]),
      },
      archiveOf,
    );

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-slot="thread-canvas-card"][data-run-id="b"] [data-slot="thread-head-archive"]',
        )!
        .click();
    });

    expect(archiveOf).toHaveBeenCalledWith('b');
    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledWith('b');
  });

  it('draws no archive icon on the cards without a provider standing', () => {
    drawLayer();

    expect(
      container.querySelector('[data-slot="thread-head-archive"]'),
    ).toBeNull();
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

describe('ThreadCardLayer — following the flow’s pan and zoom', () => {
  it('places each card on its slot at the flow’s zoom and pan, and moves it with each pan or zoom', () => {
    drawLayer({ slots: new Map([['a', box(100, 50)]]) });
    const wrapper = placedOf('a');

    act(() => {
      flowStore!.setState({ transform: [20, 10, 2] });
    });
    expect(wrapper.style.left).toBe('220px');
    expect(wrapper.style.top).toBe('110px');

    act(() => {
      flowStore!.setState({ transform: [30, 5, 0.5] });
    });
    expect(wrapper.style.left).toBe('80px');
    expect(wrapper.style.top).toBe('30px');
  });

  it('scales the card with the flow’s zoom, keeping its own size in card pixels so it covers its slot', () => {
    vi.useFakeTimers();
    try {
      drawLayer({ slots: new Map([['a', box(0, 0)]]) });
      const section = container.querySelector<HTMLElement>(
        '[data-slot="thread-canvas-card"][data-run-id="a"]',
      )!;

      act(() => {
        flowStore!.setState({ transform: [0, 0, 2] });
      });
      act(() => {
        vi.advanceTimersByTime(ZOOM_SETTLE_MS);
      });
      expect(scalerOf('a').style.zoom).toBe('2');
      expect(scalerOf('a').style.transform).toBe('');
      expect(section.style.width).toBe('400px');
      expect(section.style.height).toBe('366px');

      act(() => {
        flowStore!.setState({ transform: [0, 0, 0.5] });
      });
      act(() => {
        vi.advanceTimersByTime(ZOOM_SETTLE_MS);
      });
      expect(scalerOf('a').style.zoom).toBe('0.5');
      expect(section.style.width).toBe('400px');
    } finally {
      vi.useRealTimers();
    }
  });

  it('scales a card by a transform while a zoom is moving, and lays its chat out at the new zoom only once the zoom rests', () => {
    vi.useFakeTimers();
    try {
      drawLayer({ slots: new Map([['a', box(0, 0)]]) });
      expect(scalerOf('a').style.zoom).toBe('1');

      act(() => {
        flowStore!.setState({ transform: [0, 0, 1.5] });
      });
      act(() => {
        flowStore!.setState({ transform: [0, 0, 2] });
      });
      expect(scalerOf('a').style.zoom).toBe('1');
      expect(scalerOf('a').style.transform).toBe('scale(2)');

      act(() => {
        vi.advanceTimersByTime(ZOOM_SETTLE_MS - 1);
      });
      expect(scalerOf('a').style.zoom).toBe('1');

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(scalerOf('a').style.zoom).toBe('2');
      expect(scalerOf('a').style.transform).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the scale when a moving zoom comes back to the one the card holds, and keeps deferring through a pan', () => {
    vi.useFakeTimers();
    try {
      drawLayer({ slots: new Map([['a', box(0, 0)]]) });

      act(() => {
        flowStore!.setState({ transform: [0, 0, 1.5] });
      });
      act(() => {
        flowStore!.setState({ transform: [0, 0, 1] });
      });
      expect(scalerOf('a').style.transform).toBe('');
      expect(scalerOf('a').style.zoom).toBe('1');

      act(() => {
        flowStore!.setState({ transform: [0, 0, 2] });
      });
      act(() => {
        flowStore!.setState({ transform: [40, 10, 2] });
      });
      expect(scalerOf('a').style.zoom).toBe('1');
      expect(scalerOf('a').style.transform).toBe('scale(2)');

      act(() => {
        vi.advanceTimersByTime(ZOOM_SETTLE_MS);
      });
      expect(scalerOf('a').style.zoom).toBe('2');
      expect(scalerOf('a').style.transform).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not render the chat again for a pan or a zoom', () => {
    let renders = 0;
    function ChatProbe(): React.JSX.Element {
      renders += 1;
      return <span data-slot="card-chat" />;
    }
    drawLayer({ renderChat: () => <ChatProbe /> });
    const mounted = renders;

    act(() => {
      flowStore!.setState({ transform: [30, 5, 0.5] });
    });
    act(() => {
      flowStore!.setState({ transform: [-10, 0, 1.5] });
    });
    expect(renders).toBe(mounted);

    drawLayer({
      renderChat: () => <ChatProbe />,
      pane: { width: 1001, height: 800 },
    });
    expect(renders).toBeGreaterThan(mounted);
  });
});

describe('ThreadCardLayer — the flash', () => {
  it('flashes only the card it is given, and replays it for a new seq', () => {
    drawLayer({
      cards: [card('a', 400, 300), card('b', 400, 300)],
      slots: new Map([
        ['a', box(0, 0)],
        ['b', box(500, 0)],
      ]),
      flashing: { runId: 'a', seq: 1 },
    });
    const first = flashOf('a');

    expect(first).not.toBeNull();
    expect(flashOf('b')).toBeNull();

    drawLayer({
      cards: [card('a', 400, 300), card('b', 400, 300)],
      slots: new Map([
        ['a', box(0, 0)],
        ['b', box(500, 0)],
      ]),
      flashing: { runId: 'a', seq: 2 },
    });
    expect(flashOf('a')).not.toBeNull();
    expect(flashOf('a')).not.toBe(first);
  });
});

describe('ThreadCardLayer — dragging a card by its head', () => {
  it('a press that travels less than the drag threshold is a click, and moves nothing', () => {
    const onMove = vi.fn();
    drawLayer({ onMove, slots: new Map([['a', box(100, 40)]]) });

    act(() => {
      headOf('a').dispatchEvent(pointer('pointerdown', 100, 100));
    });
    act(() => {
      headOf('a').dispatchEvent(pointer('pointermove', 103, 102));
    });
    act(() => {
      headOf('a').dispatchEvent(pointer('pointerup', 103, 102));
    });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('moves the card with the pointer past the threshold, and hands its place up once on release', () => {
    const onMove = vi.fn();
    drawLayer({ onMove, slots: new Map([['a', box(100, 40)]]) });
    act(() => {
      flowStore!.setState({ transform: [0, 0, 1] });
    });

    act(() => {
      headOf('a').dispatchEvent(pointer('pointerdown', 100, 100));
    });
    act(() => {
      headOf('a').dispatchEvent(pointer('pointermove', 150, 130));
    });
    expect(onMove).toHaveBeenNthCalledWith(1, 'a', { x: 150, y: 70 }, false);

    act(() => {
      headOf('a').dispatchEvent(pointer('pointerup', 150, 130));
    });
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onMove).toHaveBeenNthCalledWith(2, 'a', { x: 150, y: 70 }, true);
  });

  it('measures the drag in flow units, so at zoom 2 the same screen move carries the card half as far', () => {
    const onMove = vi.fn();
    drawLayer({ onMove, slots: new Map([['a', box(100, 40)]]) });
    act(() => {
      flowStore!.setState({ transform: [0, 0, 2] });
    });

    act(() => {
      headOf('a').dispatchEvent(pointer('pointerdown', 100, 100));
    });
    act(() => {
      headOf('a').dispatchEvent(pointer('pointermove', 150, 130));
    });

    expect(onMove).toHaveBeenNthCalledWith(1, 'a', { x: 125, y: 55 }, false);
  });

  it('measures every move from where the card stood when the drag began, while its slot follows the pointer', () => {
    const onMove = vi.fn();
    drawLayer({ onMove, slots: new Map([['a', box(100, 40)]]) });
    act(() => {
      flowStore!.setState({ transform: [0, 0, 1] });
    });

    act(() => {
      headOf('a').dispatchEvent(pointer('pointerdown', 100, 100));
    });
    act(() => {
      headOf('a').dispatchEvent(pointer('pointermove', 150, 130));
    });
    drawLayer({ onMove, slots: new Map([['a', box(150, 70)]]) });
    act(() => {
      headOf('a').dispatchEvent(pointer('pointermove', 170, 140));
    });

    expect(onMove).toHaveBeenLastCalledWith('a', { x: 170, y: 80 }, false);
  });

  it('starts a new press afresh when the last one never came back up', () => {
    const onMove = vi.fn();
    drawLayer({ onMove, slots: new Map([['a', box(100, 40)]]) });
    act(() => {
      flowStore!.setState({ transform: [0, 0, 1] });
    });

    act(() => {
      headOf('a').dispatchEvent(pointer('pointerdown', 100, 100));
    });
    act(() => {
      headOf('a').dispatchEvent(pointer('pointerdown', 300, 300));
    });
    act(() => {
      headOf('a').dispatchEvent(pointer('pointermove', 350, 330));
    });

    expect(onMove).toHaveBeenLastCalledWith('a', { x: 150, y: 70 }, false);
  });

  it('drops a cancelled drag where the pointer was last followed, not where the cancel reports it', () => {
    const onMove = vi.fn();
    drawLayer({ onMove, slots: new Map([['a', box(100, 40)]]) });
    act(() => {
      flowStore!.setState({ transform: [0, 0, 1] });
    });

    act(() => {
      headOf('a').dispatchEvent(pointer('pointerdown', 100, 100));
    });
    act(() => {
      headOf('a').dispatchEvent(pointer('pointermove', 150, 130));
    });
    act(() => {
      headOf('a').dispatchEvent(pointer('pointercancel', 0, 0));
    });

    expect(onMove).toHaveBeenLastCalledWith('a', { x: 150, y: 70 }, true);
  });
});
