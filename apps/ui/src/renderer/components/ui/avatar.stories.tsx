import type { Meta, StoryObj } from '@storybook/react-vite';

import { InitialsAvatar } from './avatar';

const meta = {
  title: 'Primitives/Avatar',
  component: InitialsAvatar,
  args: { name: 'Flaky (cursor)' },
  argTypes: {
    size: { control: 'select', options: ['sm', 'md'] },
  },
} satisfies Meta<typeof InitialsAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      <InitialsAvatar {...args} size="sm" />
      <InitialsAvatar {...args} size="md" />
    </div>
  ),
};

export const Solid: Story = {
  args: { name: 'You', solid: true },
};

export const AgentGroup: Story = {
  render: () => (
    <div className="flex items-center -space-x-1.5">
      <InitialsAvatar name="Poet" size="sm" />
      <InitialsAvatar name="Review: optimizations" size="sm" />
      <InitialsAvatar name="Flaky (cursor)" size="sm" />
      <InitialsAvatar name="Docs writer" size="sm" />
      <InitialsAvatar name="You" solid size="sm" />
    </div>
  ),
};
