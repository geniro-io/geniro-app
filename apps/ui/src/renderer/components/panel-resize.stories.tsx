import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  type PanelEdge,
  PanelResizeHandle,
  usePanelWidth,
} from './panel-resize';

/**
 * Driven by the app's own `usePanelWidth`, not a copy of it.
 *
 * A hand-written drag loop reproduces the clamping and silently drops the rest
 * of what the hook does — the `col-resize`/`row-resize` cursor, the
 * `user-select: none` that stops the page selecting text mid-drag, and the
 * persist-at-drag-end — so the catalog would demonstrate a degraded version of
 * the component it documents.
 */
function ResizeDemo({
  edge,
  label,
  min,
  max,
  initial,
}: {
  edge: PanelEdge;
  label: string;
  min: number;
  max: number;
  initial: number;
}): React.JSX.Element {
  const { width, minWidth, maxWidth, startResize, resizeTo } = usePanelWidth({
    // Namespaced away from the app's own keys: the hook persists, and the
    // catalog must not write over a width the user set in the real window.
    storageKey: `storybook:panel-resize:${edge}`,
    defaultWidth: initial,
    minWidth: min,
    maxWidth: max,
    handleEdge: edge,
  });
  const vertical = edge === 'left' || edge === 'right';

  return (
    <div
      className="relative rounded-lg border border-border bg-card"
      style={vertical ? { width, height: 220 } : { width: 320, height: width }}>
      <div className="p-3 text-xs text-muted-foreground">
        {Math.round(width)}px
      </div>
      <PanelResizeHandle
        edge={edge}
        label={label}
        value={width}
        min={minWidth}
        max={maxWidth}
        onMouseDown={startResize}
        onResize={resizeTo}
      />
    </div>
  );
}

const meta = {
  title: 'Components/PanelResizeHandle',
  component: PanelResizeHandle,
  // Dummy defaults satisfying the required-args type — every story below
  // fully overrides `render` with its own `ResizeDemo` and ignores these.
  args: {
    edge: 'right',
    label: 'Resize',
    value: 0,
    min: 0,
    max: 0,
    onMouseDown: () => undefined,
    onResize: () => undefined,
  },
} satisfies Meta<typeof PanelResizeHandle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <ResizeDemo
      edge="right"
      label="Resize side panel"
      min={220}
      max={480}
      initial={320}
    />
  ),
};

export const LeftEdge: Story = {
  render: () => (
    <ResizeDemo
      edge="left"
      label="Resize navigation rail"
      min={180}
      max={360}
      initial={240}
    />
  ),
};

export const BottomEdge: Story = {
  render: () => (
    <ResizeDemo
      edge="bottom"
      label="Resize debug drawer"
      min={160}
      max={480}
      initial={240}
    />
  ),
};
