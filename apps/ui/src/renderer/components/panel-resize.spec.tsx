// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PanelResizeHandle, usePanelWidth } from './panel-resize';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A right-side panel like the inspector: the handle sits on its LEFT edge. */
function RightPanel(): React.JSX.Element {
  const { width, minWidth, maxWidth, startResize, resizeTo } = usePanelWidth({
    storageKey: 'test.rightPanelWidth',
    defaultWidth: 300,
    minWidth: 240,
    maxWidth: 480,
    handleEdge: 'left',
  });
  return (
    <aside style={{ width }} className="relative">
      <PanelResizeHandle
        edge="left"
        label="Resize panel"
        onMouseDown={startResize}
        value={width}
        min={minWidth}
        max={maxWidth}
        onResize={resizeTo}
      />
    </aside>
  );
}

function width(): number {
  return parseInt(container.querySelector('aside')!.style.width || '0', 10);
}

function drag(fromX: number, toX: number): void {
  const handle = container.querySelector('[role="separator"]')!;
  act(() => {
    handle.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, clientX: fromX }),
    );
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: toX }));
    window.dispatchEvent(new MouseEvent('mouseup'));
  });
}

describe('usePanelWidth (left-edge handle)', () => {
  // The palette spec covers the right-edge direction; this pins the inverted
  // math of a right-side panel — dragging LEFT (away from it) widens it.
  it('widens when dragging away from the panel and persists', () => {
    act(() => {
      root.render(<RightPanel />);
    });
    expect(width()).toBe(300);

    drag(1000, 940); // 60px toward the canvas → +60
    expect(width()).toBe(360);
    expect(localStorage.getItem('test.rightPanelWidth')).toBe('360');
  });

  it('persists only on drag-end, not on every mousemove', () => {
    localStorage.setItem('test.rightPanelWidth', '300');
    act(() => {
      root.render(<RightPanel />);
    });
    const handle = container.querySelector('[role="separator"]')!;
    act(() => {
      handle.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 1000 }),
      );
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 960 })); // +40
    });
    // The width tracks the drag live...
    expect(width()).toBe(340);
    // ...but localStorage is NOT written until the gesture ends. The reverted
    // bug — a [width] effect — would have flushed '340' here, mid-drag.
    expect(localStorage.getItem('test.rightPanelWidth')).toBe('300');

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(localStorage.getItem('test.rightPanelWidth')).toBe('340');
  });

  it('clamps to the min/max bounds', () => {
    act(() => {
      root.render(<RightPanel />);
    });
    drag(1000, 1500); // far right → would be 300 − 500
    expect(width()).toBe(240);
    drag(1000, 0); // far left → would be 240 + 1000
    expect(width()).toBe(480);
  });

  it('restores the persisted width on mount', () => {
    localStorage.setItem('test.rightPanelWidth', '420');
    act(() => {
      root.render(<RightPanel />);
    });
    expect(width()).toBe(420);
  });

  it('clamps a persisted width from outside the current bounds on restore', () => {
    // Bounds can tighten between versions (or the stored value be hand-edited)
    // — restoring it raw would mount the panel outside what the handle can
    // ever drag back to.
    localStorage.setItem('test.rightPanelWidth', '9000');
    act(() => {
      root.render(<RightPanel />);
    });
    expect(width()).toBe(480);

    act(() => root.unmount());
    root = createRoot(container);
    localStorage.setItem('test.rightPanelWidth', '50');
    act(() => {
      root.render(<RightPanel />);
    });
    expect(width()).toBe(240);
  });
});

describe('PanelResizeHandle keyboard (window-splitter pattern)', () => {
  function key(name: string): void {
    const handle = container.querySelector('[role="separator"]')!;
    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true }),
      );
    });
  }

  it('is focusable and reports its value semantics', () => {
    act(() => {
      root.render(<RightPanel />);
    });
    const handle = container.querySelector('[role="separator"]')!;
    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.getAttribute('aria-valuenow')).toBe('300');
    expect(handle.getAttribute('aria-valuemin')).toBe('240');
    expect(handle.getAttribute('aria-valuemax')).toBe('480');
  });

  it('arrow keys move the separator (left widens a right-side panel), clamped and persisted', () => {
    act(() => {
      root.render(<RightPanel />);
    });
    key('ArrowLeft'); // separator left → panel widens
    expect(width()).toBe(316);
    expect(localStorage.getItem('test.rightPanelWidth')).toBe('316');
    key('ArrowRight'); // separator right → back down
    expect(width()).toBe(300);
    expect(
      container
        .querySelector('[role="separator"]')!
        .getAttribute('aria-valuenow'),
    ).toBe('300');
  });

  it('Home/End jump to the bounds', () => {
    act(() => {
      root.render(<RightPanel />);
    });
    key('Home');
    expect(width()).toBe(240);
    key('End');
    expect(width()).toBe(480);
  });

  it('right-edge handle (a left-side panel): ArrowRight widens — the sign flips with the edge', () => {
    // The palette's handle sits on its RIGHT edge, so moving the separator
    // right widens the panel — the inverse of the RightPanel fixture above.
    function LeftPanel(): React.JSX.Element {
      const { width, minWidth, maxWidth, startResize, resizeTo } =
        usePanelWidth({
          storageKey: 'test.leftPanelWidth',
          defaultWidth: 240,
          minWidth: 180,
          maxWidth: 400,
          handleEdge: 'right',
        });
      return (
        <aside style={{ width }} className="relative">
          <PanelResizeHandle
            edge="right"
            label="Resize panel"
            onMouseDown={startResize}
            value={width}
            min={minWidth}
            max={maxWidth}
            onResize={resizeTo}
          />
        </aside>
      );
    }
    act(() => {
      root.render(<LeftPanel />);
    });
    key('ArrowRight');
    expect(width()).toBe(256);
    key('ArrowLeft');
    expect(width()).toBe(240);
  });
});
