import type { Meta, StoryObj } from '@storybook/react-vite';

import { ThreadOpenContext } from './thread-message-card';
import { ThreadWakeDivider } from './thread-wake-divider';

const meta = {
  title: 'Chats/ThreadWakeDivider',
  component: ThreadWakeDivider,
  args: {
    caller: 'Manager',
    fromRunId: 'r-pelican',
    fromTitle: 'Pelican',
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
} satisfies Meta<typeof ThreadWakeDivider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Woken: Story = {};

export const WithoutAName: Story = {
  args: { caller: null },
};
