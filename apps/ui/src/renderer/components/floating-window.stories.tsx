import type { Meta, StoryObj } from '@storybook/react-vite';
import * as React from 'react';

import {
  cascadeRect,
  clampRect,
  type FloatingBounds,
  type FloatingRect,
  FloatingWindow,
} from './floating-window';
import { Button } from './ui/button';
import { useElementSize } from './use-element-size';

const noop = (): void => {};

const BODY_LINES = Array.from(
  { length: 24 },
  (_, index) => `Event ${index + 1}: synthetic line for the layout check`,
);

const THREADS = [
  { id: 'ada', name: 'Ada', status: 'running' },
  { id: 'grace', name: 'Grace', status: 'waiting on you' },
];

function ThreadBody(): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm text-muted-foreground">
      {BODY_LINES.map((line) => (
        <p key={line} className="py-1">
          {line}
        </p>
      ))}
    </div>
  );
}

function Canvas({
  children,
}: {
  children: (bounds: FloatingBounds) => React.ReactNode;
}): React.JSX.Element {
  const [measure, bounds] = useElementSize();
  return (
    <div
      ref={measure}
      className="relative h-[520px] overflow-hidden rounded-card bg-muted/30 ring-1 ring-border">
      {bounds.width > 0 && children(bounds)}
    </div>
  );
}

function ThreadWindowsDemo(): React.JSX.Element {
  const [rects, setRects] = React.useState<Record<string, FloatingRect>>({});
  const [order, setOrder] = React.useState<string[]>(
    THREADS.map((thread) => thread.id),
  );
  const [closed, setClosed] = React.useState<string[]>([]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {THREADS.map((thread) => (
          <Button
            key={thread.id}
            type="button"
            variant="outline"
            size="sm"
            disabled={!closed.includes(thread.id)}
            onClick={() =>
              setClosed((prev) => prev.filter((id) => id !== thread.id))
            }>
            Show {thread.name}
          </Button>
        ))}
      </div>
      <Canvas>
        {(bounds) =>
          THREADS.map((thread, index) => {
            if (closed.includes(thread.id)) {
              return null;
            }
            return (
              <FloatingWindow
                key={thread.id}
                label={`Thread ${thread.name}`}
                title={`${thread.name} · ${thread.status}`}
                actions={
                  <Button type="button" variant="outline" size="sm">
                    Answer
                  </Button>
                }
                rect={clampRect(
                  rects[thread.id] ?? cascadeRect(index, bounds),
                  bounds,
                )}
                onRectChange={(rect) =>
                  setRects((prev) => ({ ...prev, [thread.id]: rect }))
                }
                bounds={bounds}
                zIndex={10 + order.indexOf(thread.id)}
                onFocus={() =>
                  setOrder((prev) => [
                    ...prev.filter((id) => id !== thread.id),
                    thread.id,
                  ])
                }
                onClose={() => setClosed((prev) => [...prev, thread.id])}>
                <ThreadBody />
              </FloatingWindow>
            );
          })
        }
      </Canvas>
    </div>
  );
}

function FullScreenDemo(): React.JSX.Element {
  return (
    <Canvas>
      {(bounds) => (
        <FloatingWindow
          fullScreen
          label="Thread Ada"
          title="Ada · running"
          actions={
            <Button type="button" variant="outline" size="sm">
              Answer
            </Button>
          }
          rect={cascadeRect(0, bounds)}
          onRectChange={noop}
          bounds={bounds}
          zIndex={10}
          onFocus={noop}
          onClose={noop}>
          <ThreadBody />
        </FloatingWindow>
      )}
    </Canvas>
  );
}

const meta = {
  title: 'Components/FloatingWindow',
  component: FloatingWindow,
  args: {
    label: 'Thread Ada',
    title: 'Ada · running',
    rect: { x: 16, y: 16, width: 460, height: 560 },
    bounds: { width: 1000, height: 520 },
    zIndex: 10,
    onRectChange: noop,
    onFocus: noop,
    onClose: noop,
    children: <p className="p-3 text-sm">Body</p>,
  },
} satisfies Meta<typeof FloatingWindow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TwoThreads: Story = {
  render: () => <ThreadWindowsDemo />,
};

export const FullScreen: Story = {
  args: { fullScreen: true },
  render: () => <FullScreenDemo />,
};
