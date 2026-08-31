import type { Meta, StoryObj } from '@storybook/react-vite';
import { Users } from 'lucide-react';
import { userEvent, within } from 'storybook/test';

import { HoverPopover } from './hover-popover';

const meta = {
  title: 'Components/HoverPopover',
  component: HoverPopover,
  args: {
    label: 'Sub-agents',
    panelLabel: 'Running sub-agents',
    trigger: (
      <span className="flex items-center gap-1 px-1.5 text-xs text-muted-foreground">
        <Users aria-hidden="true" className="size-3.5" />3
      </span>
    ),
    children: (
      <ul className="flex flex-col gap-1 text-sm">
        <li>Review: optimizations</li>
        <li>Review: security</li>
        <li>Review: tests</li>
      </ul>
    ),
  },
  decorators: [
    (story) => (
      <div className="flex h-40 w-64 items-start justify-center pt-4">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof HoverPopover>;

export default meta;
type Story = StoryObj<typeof meta>;

// A press pins the panel open immediately (no hover delay), so the play
// function drives the same interaction a mouse or keyboard user would — the
// component owns its open state and offers no prop to force it open, which
// is why a closed-by-default story would show an empty canvas.
//
// Parameterised by the trigger's accessible name, which is the story's own
// `label`: `getByRole` THROWS when nothing matches, so a shared play function
// carrying one story's label fails the interaction on every other story.
const openPanel =
  (name: string): NonNullable<Story['play']> =>
  async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name }));
  };

export const Playground: Story = {
  play: openPanel('Sub-agents'),
};

export const Empty: Story = {
  args: {
    label: 'Terminals',
    panelLabel: 'Running terminals',
    children: (
      <p className="px-1 py-1 text-sm text-muted-foreground">
        Nothing running.
      </p>
    ),
  },
  play: openPanel('Terminals'),
};
