import type { Meta, StoryObj } from '@storybook/react-vite';

import { Logo } from './logo';

const meta = {
  title: 'Components/Logo',
  component: Logo,
  argTypes: {
    size: { control: 'select', options: ['topbar', 'nav', 'hero'] },
  },
} satisfies Meta<typeof Logo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-end gap-6">
      <Logo {...args} size="topbar" />
      <Logo {...args} size="nav" />
      <Logo {...args} size="hero" />
    </div>
  ),
};
