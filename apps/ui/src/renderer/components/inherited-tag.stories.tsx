import type { Meta, StoryObj } from '@storybook/react-vite';

import { InheritedTag } from './inherited-tag';

const meta = {
  title: 'Components/InheritedTag',
  component: InheritedTag,
  args: { variant: 'project' },
} satisfies Meta<typeof InheritedTag>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Project: Story = {};

export const Team: Story = { args: { variant: 'team' } };

export const Overridden: Story = { args: { variant: 'overridden' } };

export const BesideAValue: Story = {
  render: (args) => (
    <div className="flex w-72 items-center justify-between gap-2 text-sm">
      <span>Effort: high</span>
      <InheritedTag {...args} />
    </div>
  ),
  args: { variant: 'overridden' },
};
