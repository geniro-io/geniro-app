import type { Meta, StoryObj } from '@storybook/react-vite';
import { GitBranch } from 'lucide-react';

import { Chip, ChipChevron } from './chip';

const meta = {
  title: 'Primitives/Chip',
  component: Chip,
  args: { children: 'main' },
  argTypes: {
    tone: { control: 'select', options: ['active', 'muted'] },
    interactive: { control: 'boolean' },
  },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Static: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Chip tone="muted">
        <GitBranch />
        main
      </Chip>
      <Chip tone="active">3 sub-agents</Chip>
    </div>
  ),
};

export const Picker: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Chip interactive tone="active">
        <GitBranch />
        main
        <ChipChevron />
      </Chip>
      <Chip
        interactive
        tone="active"
        aria-disabled
        className="pointer-events-none opacity-50">
        Locked while running
        <ChipChevron />
      </Chip>
    </div>
  ),
};
