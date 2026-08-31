import type { Meta, StoryObj } from '@storybook/react-vite';

import { ProgressBar } from './progress-bar';

const meta = {
  title: 'Primitives/ProgressBar',
  component: ProgressBar,
  args: { fraction: 0.62, label: 'Download progress' },
} satisfies Meta<typeof ProgressBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => (
    <div className="w-64">
      <ProgressBar {...args} />
    </div>
  ),
};

export const Indeterminate: Story = {
  args: { fraction: null, label: 'Unpacking' },
  render: (args) => (
    <div className="w-64">
      <ProgressBar {...args} />
    </div>
  ),
};

export const Empty: Story = {
  args: { fraction: 0 },
  render: (args) => (
    <div className="w-64">
      <ProgressBar {...args} />
    </div>
  ),
};

export const Full: Story = {
  args: { fraction: 1 },
  render: (args) => (
    <div className="w-64">
      <ProgressBar {...args} />
    </div>
  ),
};
