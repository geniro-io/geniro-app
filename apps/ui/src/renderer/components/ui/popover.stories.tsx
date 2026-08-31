import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';

import { Button } from './button';
import { Popover } from './popover';

const meta = {
  title: 'Primitives/Popover',
  component: Popover,
  args: { open: true, onClose: () => {}, label: 'Popover', children: null },
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Open by default, so the catalog shows the panel rather than an empty canvas. */
export const Playground: Story = {
  render: () => {
    function PopoverDemo(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      const triggerRef = useRef<HTMLButtonElement | null>(null);
      return (
        <div className="relative inline-block">
          <Button
            ref={triggerRef}
            variant="outline"
            onClick={() => setOpen((v) => !v)}>
            Pull requests
          </Button>
          <Popover
            open={open}
            onClose={() => setOpen(false)}
            triggerRef={triggerRef}
            side="bottom"
            label="Pull requests opened by this thread">
            <div className="w-64 p-3 text-sm text-foreground">
              <p className="font-medium">Opened by this thread</p>
              <p className="mt-1 text-muted-foreground">
                #79 — feat: shelf labels and config profiles
              </p>
            </div>
          </Popover>
        </div>
      );
    }
    return <PopoverDemo />;
  },
};

export const AlignEnd: Story = {
  render: () => {
    function PopoverDemo(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      const triggerRef = useRef<HTMLButtonElement | null>(null);
      return (
        <div className="relative flex justify-end">
          <Button
            ref={triggerRef}
            variant="outline"
            onClick={() => setOpen((v) => !v)}>
            Account
          </Button>
          <Popover
            open={open}
            onClose={() => setOpen(false)}
            triggerRef={triggerRef}
            side="bottom"
            align="end"
            label="Account menu">
            <div className="w-56 p-3 text-sm text-foreground">
              Panel pinned to the trigger's trailing edge.
            </div>
          </Popover>
        </div>
      );
    }
    return <PopoverDemo />;
  },
};
