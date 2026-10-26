import type { Meta, StoryObj } from '@storybook/react-vite';

import { SegmentBreakdown } from './segment-breakdown';

const meta = {
  title: 'Components/SegmentBreakdown',
  component: SegmentBreakdown,
  args: {
    denominator: 200_000,
    segments: [
      {
        key: 'system',
        label: 'System prompt',
        value: 24_000,
        colorClass: 'bg-avatar-1',
        figures: ['24k'],
      },
      {
        key: 'tools',
        label: 'Tools',
        value: 61_000,
        colorClass: 'bg-avatar-2',
        figures: ['61k'],
      },
      {
        key: 'messages',
        label: 'Messages',
        value: 38_000,
        colorClass: 'bg-avatar-3',
        figures: ['38k'],
      },
    ],
    remainder: { label: 'Free space', figures: ['77k'] },
  },
  decorators: [
    (story) => (
      <div className="flex w-80 flex-col gap-2 text-xs">{story()}</div>
    ),
  ],
} satisfies Meta<typeof SegmentBreakdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A window: segments over the whole, the empty tail listed as free space. */
export const Window: Story = {};

/** Two figure columns per row, and no remainder. */
export const TwoColumns: Story = {
  args: {
    denominator: 123_000,
    segments: [
      {
        key: 'role',
        label: 'Role',
        value: 100_000,
        colorClass: 'bg-avatar-1',
        figures: ['100,000', '~25k'],
      },
      {
        key: 'block',
        label: 'Team Settings',
        value: 23_000,
        colorClass: 'bg-avatar-2',
        figures: ['23,000', '~5.8k'],
      },
    ],
    remainder: undefined,
  },
};
