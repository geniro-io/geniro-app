import type { Meta, StoryObj } from '@storybook/react-vite';

import { MilestoneRow } from './milestone-row';

const meta = {
  title: 'Chats/MilestoneRow',
  component: MilestoneRow,
  args: {
    author: 'Engineer',
    time: '14:02',
    milestone: {
      kind: 'progress',
      text: 'Wrote the timeline route; the events query is next.',
      nodeId: 'engineer',
      conversationId: null,
    },
  },
  decorators: [
    (story) => <div className="w-[560px] bg-background p-4">{story()}</div>,
  ],
} satisfies Meta<typeof MilestoneRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Progress: Story = {};

export const Problem: Story = {
  args: {
    milestone: {
      kind: 'problem',
      text: 'The affected-tests run fails on the base too; checking whether it is a flake.',
      nodeId: 'engineer',
      conversationId: null,
    },
  },
};

export const Done: Story = {
  args: {
    milestone: {
      kind: 'done',
      text: 'Acceptance checks green on the pushed HEAD.',
      nodeId: 'engineer',
      conversationId: null,
    },
  },
};

export const WithoutTeam: Story = {
  args: { author: null },
};
