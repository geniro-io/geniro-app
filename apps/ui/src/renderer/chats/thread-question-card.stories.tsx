import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import {
  bareThreadIdentity,
  type ThreadIdentity,
} from '../components/thread-head';
import { ApprovalCard } from './approval-card';
import { ThreadQuestionCard } from './thread-question-card';
import {
  type ThreadContextReader,
  ThreadContextReaderContext,
} from './thread-question-context';
import { ThreadIdentityContext } from './thread-title';

const IDENTITIES = new Map<string, ThreadIdentity>([
  [
    'thread-1',
    {
      ...bareThreadIdentity('CI-1235: PDF previews don’t open in Safari 17'),
      face: { kind: 'agent', icon: 'terminal', name: 'claude' },
      status: { attention: 'question', text: 'Question for you' },
      agentLabel: 'claude',
      pullRequest: { number: 212, state: 'draft', url: null },
      project: 'Web',
      projectColor: 'teal',
    },
  ],
]);

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

const READER: ThreadContextReader = () =>
  Promise.resolve([
    { seq: 3, role: 'user', text: 'Clear the billing cache before the deploy' },
    {
      seq: 4,
      role: 'assistant',
      text: 'Two caches could be meant: Redis and the local copy.',
    },
  ]);

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
    (story) => (
      <div className="w-[560px] bg-background p-4">
        <ThreadContextReaderContext.Provider value={READER}>
          <ThreadIdentityContext.Provider value={IDENTITIES}>
            {story()}
          </ThreadIdentityContext.Provider>
        </ThreadContextReaderContext.Provider>
      </div>
    ),
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

export const UnknownThread: Story = {
  args: { relay: { ...RELAY, threadRunId: 'thread-unknown' } },
};
