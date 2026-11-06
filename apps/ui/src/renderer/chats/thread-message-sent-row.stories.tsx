import type { Meta, StoryObj } from '@storybook/react-vite';

import { ThreadOpenContext } from './thread-message-card';
import { ThreadMessageSentRow } from './thread-message-sent-row';

const meta = {
  title: 'Chats/ThreadMessageSentRow',
  component: ThreadMessageSentRow,
  args: {
    sent: {
      toRunId: 'r-otter',
      title: 'Otter',
      outcome: 'waiting',
      reason: 'stopped',
    },
  },
  decorators: [
    (story) => (
      <div className="w-[360px] bg-background p-3 text-foreground">
        <ThreadOpenContext.Provider value={() => {}}>
          {story()}
        </ThreadOpenContext.Provider>
      </div>
    ),
  ],
} satisfies Meta<typeof ThreadMessageSentRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Waiting: Story = {};

export const Joined: Story = {
  args: {
    sent: {
      toRunId: 'r-otter',
      title: 'Otter',
      outcome: 'joined',
      reason: null,
    },
  },
};

export const Woken: Story = {
  args: {
    sent: {
      toRunId: 'r-otter',
      title: 'Otter',
      outcome: 'woken',
      reason: null,
    },
  },
};
