import type { Meta, StoryObj } from '@storybook/react-vite';

import { EmptyState } from './empty-state';

const meta = {
  title: 'Components/EmptyState',
  component: EmptyState,
  args: { children: 'No chats yet.' },
  decorators: [
    (story) => (
      <div className="h-40 w-80 rounded-lg border border-border">{story()}</div>
    ),
  ],
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const LongMessage: Story = {
  args: {
    children:
      'Nothing on this machine is answering yet — start a chat from the sidebar, or connect to a running daemon.',
  },
};
