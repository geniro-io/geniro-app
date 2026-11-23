import type { Meta, StoryObj } from '@storybook/react-vite';

import { ThreadFace } from './thread-face';

const meta = {
  title: 'Components/ThreadFace',
  component: ThreadFace,
  args: { look: { kind: 'unknown' }, slot: 'thread-face' },
  decorators: [
    (story) => (
      <div className="flex items-center gap-4 bg-card p-3 text-foreground">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof ThreadFace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Agent: Story = {
  args: { look: { kind: 'agent', icon: 'terminal', name: 'claude' } },
};

export const Team: Story = {
  args: {
    look: {
      kind: 'team',
      total: 5,
      people: [
        { key: 'lead', name: 'Lead' },
        { key: 'senior', name: 'Senior Engineer' },
        { key: 'qa', name: 'QA' },
      ],
    },
  },
};

export const Member: Story = {
  args: {
    look: {
      kind: 'member',
      name: 'Senior Engineer',
      avatar: { kind: 'initials', value: 'SE' },
      colorKey: 'senior',
    },
  },
};

export const MemberEmoji: Story = {
  args: {
    look: {
      kind: 'member',
      name: 'QA',
      avatar: { kind: 'emoji', value: '🦊' },
      colorKey: 'qa',
    },
  },
};

export const Manager: Story = {
  args: { look: { kind: 'manager' } },
};

export const Monitor: Story = {
  args: { look: { kind: 'monitor' } },
};

export const Unknown: Story = {};
