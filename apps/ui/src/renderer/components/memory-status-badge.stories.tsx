import type { Meta, StoryObj } from '@storybook/react-vite';

import { MemoryStatusBadge } from './memory-status-badge';

const meta = {
  title: 'Components/MemoryStatusBadge',
  component: MemoryStatusBadge,
  args: { status: 'pending' },
} satisfies Meta<typeof MemoryStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingForReview: Story = {};

export const Forgotten: Story = { args: { status: 'forgotten' } };

export const ActiveDrawsNothing: Story = { args: { status: 'active' } };
