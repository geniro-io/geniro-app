import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageSquare } from 'lucide-react';
import { useState } from 'react';

import { cornerWindow, FloatingWindow } from './floating-window';
import { Button } from './ui/button';

function Page({
  phone = false,
  fullHead = false,
}: {
  phone?: boolean;
  fullHead?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <div className="relative h-[560px] w-full overflow-hidden rounded-lg border border-dashed border-border bg-sidebar/40">
      <p className="p-4 text-sm text-muted-foreground">
        The page under the window. Drag the window by its head, resize it from
        any edge or corner, minimise, maximise or close it.
      </p>
      <Button
        type="button"
        size="icon"
        className="absolute right-4 bottom-4 size-11 rounded-full"
        aria-label="Open the chat"
        onClick={() => setOpen((now) => !now)}>
        <MessageSquare aria-hidden="true" />
      </Button>
      <FloatingWindow
        label="Manager chat"
        title="Manager"
        open={open}
        phone={phone}
        fullHead={
          fullHead ? (
            <span className="flex items-center gap-1">
              {[0, 1, 2].map((index) => (
                <span key={index} className="size-6 rounded-full bg-accent" />
              ))}
            </span>
          ) : undefined
        }
        initialRect={(bounds) =>
          cornerWindow(
            bounds,
            { width: 420, height: Math.min(440, bounds.height - 88) },
            { right: 16, bottom: 72 },
          )
        }
        onClose={() => setOpen(false)}>
        <div className="flex-1 overflow-y-auto p-4 text-sm">
          {Array.from({ length: 30 }, (_, index) => (
            <p key={index} className="py-1">
              Message {index + 1} of a conversation that scrolls inside the
              window.
            </p>
          ))}
        </div>
      </FloatingWindow>
    </div>
  );
}

const meta = {
  title: 'Components/FloatingWindow',
  component: Page,
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {};

export const Phone: Story = { args: { phone: true } };

export const WithFullHead: Story = { args: { fullHead: true } };
