import type { Meta, StoryObj } from '@storybook/react-vite';

import { Badge } from './badge';

const meta = {
  title: 'Primitives/Badge',
  component: Badge,
  args: { children: 'Merged' },
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'default',
        'secondary',
        'destructive',
        'success',
        'outline',
        'muted',
      ],
    },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge {...args} variant="default" />
      <Badge {...args} variant="secondary" />
      <Badge {...args} variant="destructive" />
      <Badge {...args} variant="success" />
      <Badge {...args} variant="outline" />
      <Badge {...args} variant="muted" />
    </div>
  ),
};
