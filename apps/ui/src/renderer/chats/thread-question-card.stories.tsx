import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ApprovalCard } from './approval-card';
import { ThreadQuestionCard } from './thread-question-card';

const RELAY = {
  threadRunId: 'thread-1',
  threadIsTeam: false,
  handle: 't3',
  threadTitle: 'CI-1235: PDF previews don’t open in Safari 17',
  toolName: 'AskUserQuestion',
  input: {},
  questions: [
    {
      question: 'Should the fallback viewer ship behind a flag?',
      header: 'Flag',
      options: [
        { label: 'Behind a flag', description: 'off until QA signs off' },
        { label: 'On for everyone', description: 'ship it straight away' },
      ],
      multiSelect: false,
    },
  ],
};

const meta = {
  title: 'Chats/ThreadQuestionCard',
  component: ThreadQuestionCard,
  args: {
    relay: RELAY,
    verdict: null,
    children: null,
  },
  render: (args) => (
    <ThreadQuestionCard {...args}>
      <ApprovalCard
        toolName={args.relay.toolName}
        input={args.relay.input}
        questions={args.relay.questions}
        verdict={args.verdict}
        onRespond={fn()}
      />
    </ThreadQuestionCard>
  ),
  decorators: [
    (story) => <div className="w-[560px] bg-background p-4">{story()}</div>,
  ],
} satisfies Meta<typeof ThreadQuestionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {};

export const Answered: Story = { args: { verdict: true } };

export const NotDelivered: Story = {
  args: { verdict: true, outcome: 'not-delivered' },
};

export const Closed: Story = { args: { expired: true } };
