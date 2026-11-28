import type { Meta, StoryObj } from '@storybook/react-vite';

import { Spinner } from './spinner';

const meta = {
  title: 'Primitives/Spinner',
  component: Spinner,
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Spinner className="size-3" />
      <Spinner className="size-4" />
      <Spinner className="size-6" />
    </div>
  ),
};

export const Frames: Story = {
  args: { pace: 'frames', className: 'size-4' },
};

export const FramesSizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Spinner pace="frames" className="size-3" />
      <Spinner pace="frames" className="size-6" />
      <Spinner pace="frames" className="size-12" />
    </div>
  ),
};

export const InlineWithText: Story = {
  render: () => (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Spinner />
      Working…
    </div>
  ),
};
