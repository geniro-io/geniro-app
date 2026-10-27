// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { placeTooltip, TOOLTIP_OPEN_DELAY_MS, TooltipLayer } from './tooltip';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(ui: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <>
        {ui}
        <TooltipLayer />
      </>,
    );
  });
  return host;
}

function pointer(
  type: 'pointerover' | 'pointerout' | 'pointerdown',
  target: Element,
  init: { relatedTarget?: Element | null; pointerType?: string } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    relatedTarget: init.relatedTarget ?? null,
  });
  if (init.pointerType !== undefined) {
    Object.defineProperty(event, 'pointerType', { value: init.pointerType });
  }
  act(() => {
    target.dispatchEvent(event);
  });
}

const tooltip = (): HTMLElement | null =>
  document.querySelector('[role="tooltip"]');

const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe('TooltipLayer', () => {
  it('draws an element’s title itself after a rest, and keeps the system’s away', () => {
    const el = mount(<button title="Add thread notes">notes</button>);
    const button = el.querySelector('button')!;

    pointer('pointerover', button);
    expect(button.hasAttribute('title')).toBe(false);
    wait(TOOLTIP_OPEN_DELAY_MS - 1);
    expect(tooltip()).toBeNull();
    wait(1);

    expect(tooltip()?.textContent).toBe('Add thread notes');
  });

  it('puts the title back and closes when the pointer leaves', () => {
    const el = mount(<button title="Export">x</button>);
    const button = el.querySelector('button')!;
    pointer('pointerover', button);
    wait(TOOLTIP_OPEN_DELAY_MS);

    pointer('pointerout', button, { relatedTarget: el });

    expect(tooltip()).toBeNull();
    expect(button.getAttribute('title')).toBe('Export');
  });

  it('stays open while the pointer moves onto a child of the titled element', () => {
    const el = mount(
      <button title="Search">
        <svg data-testid="glyph" />
      </button>,
    );
    const button = el.querySelector('button')!;
    const glyph = el.querySelector('svg')!;
    pointer('pointerover', button);
    wait(TOOLTIP_OPEN_DELAY_MS);

    pointer('pointerout', button, { relatedTarget: glyph });
    pointer('pointerover', glyph);

    expect(tooltip()?.textContent).toBe('Search');
  });

  it('opens the next tooltip at once while the reader moves along a row', () => {
    const el = mount(
      <>
        <button title="First">1</button>
        <button title="Second">2</button>
      </>,
    );
    const [first, second] = [...el.querySelectorAll('button')];
    pointer('pointerover', first!);
    wait(TOOLTIP_OPEN_DELAY_MS);
    pointer('pointerout', first!, { relatedTarget: second });
    pointer('pointerover', second!);
    wait(0);

    expect(tooltip()?.textContent).toBe('Second');
    expect(first!.getAttribute('title')).toBe('First');
  });

  it('follows a title React rewrites while it is shown', async () => {
    function Copy(): React.JSX.Element {
      const [copied, setCopied] = useState(false);
      return (
        <button
          type="button"
          title={copied ? 'Copied' : 'Copy'}
          onClick={() => setCopied(true)}>
          copy
        </button>
      );
    }
    const el = mount(<Copy />);
    const button = el.querySelector('button')!;
    pointer('pointerover', button);
    wait(TOOLTIP_OPEN_DELAY_MS);

    act(() => {
      button.click();
    });
    await act(async () => {});

    expect(button.hasAttribute('title')).toBe(false);
    expect(tooltip()?.textContent).toBe('Copied');
    pointer('pointerout', button, { relatedTarget: el });
    expect(button.getAttribute('title')).toBe('Copied');
  });

  it('hides on a press and stays hidden until the pointer leaves', () => {
    const el = mount(<button title="Stop">x</button>);
    const button = el.querySelector('button')!;
    pointer('pointerover', button);
    wait(TOOLTIP_OPEN_DELAY_MS);

    pointer('pointerdown', button);
    wait(TOOLTIP_OPEN_DELAY_MS);

    expect(tooltip()).toBeNull();
  });

  it('never opens for a touch, and leaves its title alone', () => {
    const el = mount(<button title="Archive">x</button>);
    const button = el.querySelector('button')!;

    pointer('pointerover', button, { pointerType: 'touch' });
    wait(TOOLTIP_OPEN_DELAY_MS);

    expect(tooltip()).toBeNull();
    expect(button.getAttribute('title')).toBe('Archive');
  });

  it('closes when the element it belongs to goes away', () => {
    function Removable(): React.JSX.Element | null {
      const [shown, setShown] = useState(true);
      return shown ? (
        <button title="Delete" onClick={() => setShown(false)}>
          x
        </button>
      ) : null;
    }
    const el = mount(<Removable />);
    const button = el.querySelector('button')!;
    pointer('pointerover', button);
    wait(TOOLTIP_OPEN_DELAY_MS);
    expect(tooltip()).not.toBeNull();

    act(() => {
      root!.render(
        <>
          <span />
          <TooltipLayer />
        </>,
      );
    });
    wait(50);

    expect(tooltip()).toBeNull();
  });
});

describe('placeTooltip', () => {
  const viewport = { width: 800, height: 600 };

  it('centres the tooltip under its element', () => {
    expect(
      placeTooltip(
        { left: 100, top: 100, bottom: 120, width: 40 },
        { width: 60, height: 20 },
        viewport,
      ),
    ).toEqual({ left: 90, top: 128, side: 'bottom', arrow: 30 });
  });

  it('keeps the arrow on the element’s centre when the window edge pushes the tooltip aside', () => {
    const placed = placeTooltip(
      { left: 750, top: 100, bottom: 120, width: 20 },
      { width: 120, height: 24 },
      viewport,
    );
    expect(placed.left).toBe(800 - 120 - 8);
    expect(placed.left + placed.arrow).toBe(760);
  });

  it('never puts the arrow into the tooltip’s rounded corner', () => {
    const placed = placeTooltip(
      { left: 790, top: 100, bottom: 120, width: 10 },
      { width: 120, height: 24 },
      viewport,
    );
    expect(placed.arrow).toBe(120 - 12);
  });

  it('goes above an element with no room below it', () => {
    const placed = placeTooltip(
      { left: 100, top: 570, bottom: 590, width: 40 },
      { width: 60, height: 20 },
      viewport,
    );
    expect(placed.side).toBe('top');
    expect(placed.top).toBe(570 - 8 - 20);
  });

  it('keeps inside the window at either edge', () => {
    expect(
      placeTooltip(
        { left: 0, top: 100, bottom: 120, width: 10 },
        { width: 200, height: 20 },
        viewport,
      ).left,
    ).toBe(8);
    expect(
      placeTooltip(
        { left: 790, top: 100, bottom: 120, width: 10 },
        { width: 200, height: 20 },
        viewport,
      ).left,
    ).toBe(800 - 200 - 8);
  });
});
