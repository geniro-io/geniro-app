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
  const { width, startResize } = usePanelWidth({
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
});
