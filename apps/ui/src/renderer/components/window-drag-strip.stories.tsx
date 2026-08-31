import type { Meta, StoryObj } from '@storybook/react-vite';

import { WindowDragStrip } from './window-drag-strip';

const meta = {
  title: 'Components/WindowDragStrip',
  component: WindowDragStrip,
} satisfies Meta<typeof WindowDragStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

// No other states to show: the strip takes no props, and it is an invisible
// hit-region by design (only Onboarding and the loading screen render it, in
// place of a real title bar).
export const Playground: Story = {
  render: () => (
    <div className="relative h-32 w-full overflow-hidden rounded-lg border border-dashed border-border">
      <WindowDragStrip />
      <p className="px-4 pt-16 text-sm text-muted-foreground">
        An invisible 44px drag region across the top of the window, for the two
        screens that render before the shell's own title bar exists.
      </p>
    </div>
  ),
};
