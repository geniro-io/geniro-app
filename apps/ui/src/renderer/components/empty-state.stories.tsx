import type { Meta, StoryObj } from '@storybook/react-vite';
import { Users } from 'lucide-react';

import { EmptyState } from './empty-state';
import { Button } from './ui/button';

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

export const WithIconAndActions: Story = {
  args: {
    icon: <Users aria-hidden="true" />,
    children: 'No teams yet. Create one to start composing your agents.',
    actions: <Button type="button">New team</Button>,
  },
  decorators: [(story) => <div className="w-96">{story()}</div>],
};

export const LongMessage: Story = {
  args: {
    children:
      'Nothing on this machine is answering yet — start a chat from the sidebar, or connect to a running daemon.',
  },
};
