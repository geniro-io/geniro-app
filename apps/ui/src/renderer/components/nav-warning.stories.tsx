import type { Meta, StoryObj } from '@storybook/react-vite';
import { Settings } from 'lucide-react';

import { NavWarning } from './nav-warning';

const meta = {
  title: 'Components/NavWarning',
  component: NavWarning,
  args: {
    marked: true,
    children: <Settings aria-hidden="true" className="size-4 shrink-0" />,
  },
  render: (args) => (
    <div className="flex items-center gap-6 rounded-md bg-sidebar p-4 text-sidebar-foreground">
      <NavWarning {...args} />
      <NavWarning {...args} marked={false} />
    </div>
  ),
} satisfies Meta<typeof NavWarning>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Marked: Story = {};
