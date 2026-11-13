import type { Meta, StoryObj } from '@storybook/react-vite';

import type { WaitReading } from './waiting';
import { WaitingStatus } from './waiting-status';

function reading(runId: string, state: WaitReading['state']): WaitReading {
  return { runId, state, since: '2026-10-21T10:00:00.000Z' };
}

const meta = {
  title: 'Chats/WaitingStatus',
  component: WaitingStatus,
  args: {
    readings: [
      reading('approval', 'asking'),
      reading('crash', 'failed'),
      reading('reply-1', 'unseen'),
      reading('reply-2', 'unseen'),
      reading('busy', 'working'),
    ],
    onJump: () => undefined,
  },
  // The bar's own surface, so the hover tone reads as it does in the app.
  decorators: [
    (story) => (
      <div className="flex h-11 items-center bg-sidebar px-2">{story()}</div>
    ),
  ],
} satisfies Meta<typeof WaitingStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EveryWait: Story = {};

export const OneApproval: Story = {
  args: { readings: [reading('approval', 'asking')] },
};

/** Only working threads: nothing is owed, so the line draws nothing. */
export const NothingWaiting: Story = {
  args: { readings: [reading('busy', 'working')] },
};
