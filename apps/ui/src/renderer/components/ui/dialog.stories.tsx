import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from './button';
import { Dialog } from './dialog';
import { Input } from './input';
import { Label } from './label';

const meta = {
  title: 'Primitives/Dialog',
  component: Dialog,
  // A modal fills the box the docs preview gives it, and that box is sized by
  // its content — see the note in `renderer-components.md`.
  decorators: [(story) => <div className="h-[420px]">{story()}</div>],
  args: { open: true, onClose: () => {}, children: null },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Open by default, so the catalog shows the card rather than an empty canvas. */
export const Playground: Story = {
  render: () => {
    function DialogDemo(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      return (
        <>
          {!open ? (
            <Button onClick={() => setOpen(true)}>Reopen dialog</Button>
          ) : null}
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Rename chat">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="chat-name">Name</Label>
                <Input id="chat-name" defaultValue="Design system storybook" />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setOpen(false)}>Save</Button>
              </div>
            </div>
          </Dialog>
        </>
      );
    }
    return <DialogDemo />;
  },
};

export const LongContent: Story = {
  render: () => {
    function DialogDemo(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      return (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Opened by this thread — a title long enough to truncate against the ✕">
          <ul className="flex flex-col gap-2 text-sm text-foreground">
            {Array.from({ length: 12 }, (_, i) => (
              <li
                key={i}
                className="rounded-md border border-border px-2.5 py-1.5">
                Row {i + 1} — the body scrolls once it outgrows the window.
              </li>
            ))}
          </ul>
        </Dialog>
      );
    }
    return <DialogDemo />;
  },
};
