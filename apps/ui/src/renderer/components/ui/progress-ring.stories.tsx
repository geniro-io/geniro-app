import type { Meta, StoryObj } from '@storybook/react-vite';

import { ProgressRing } from './progress-ring';

const meta = {
  title: 'Primitives/ProgressRing',
  component: ProgressRing,
  args: { fraction: 0.7, label: 'Context window used' },
} satisfies Meta<typeof ProgressRing>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-3 text-primary">
      <ProgressRing {...args} size={12} />
      <ProgressRing {...args} size={16} />
      <ProgressRing {...args} size={24} />
      <ProgressRing {...args} size={32} />
    </div>
  ),
};

export const Fractions: Story = {
  render: (args) => (
    <div className="flex items-center gap-3 text-primary">
      <ProgressRing {...args} fraction={0} />
      <ProgressRing {...args} fraction={0.25} />
      <ProgressRing {...args} fraction={0.5} />
      <ProgressRing {...args} fraction={0.9} />
      <ProgressRing {...args} fraction={1} />
    </div>
  ),
};

export const Tones: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      <ProgressRing {...args} fraction={0.4} className="text-primary" />
      <ProgressRing {...args} fraction={0.85} className="text-destructive" />
      <ProgressRing {...args} fraction={1} className="text-success" />
    </div>
  ),
};
