import type { Meta, StoryObj } from '@storybook/react-vite';

import { bareThreadIdentity, ThreadHead } from './thread-head';

const meta = {
  title: 'Components/ThreadHead',
  component: ThreadHead,
  args: {
    slot: 'thread-head',
    onOpen: () => undefined,
    identity: {
      title: 'NCDEX_IND: add agro commodities',
      face: { kind: 'agent', icon: 'terminal', name: 'claude' },
      pullRequest: { number: 146, state: 'open', url: null },
      status: { attention: 'working', text: 'Working' },
      agentLabel: 'claude',
      isTeam: false,
      boardCard: {
        identifier: 'PRI-10',
        title: 'Agro commodities',
        status: 'in_progress',
      },
      project: 'PriceField',
      projectColor: 'orange',
    },
  },
  decorators: [
    (story) => (
      <div className="w-[420px] bg-card p-3 text-foreground">{story()}</div>
    ),
  ],
} satisfies Meta<typeof ThreadHead>;

export default meta;
type Story = StoryObj<typeof meta>;

export const KnownThread: Story = {};

export const TeamWaitingOnYou: Story = {
  args: {
    identity: {
      title: 'Stage 5 — the Elves batch',
      face: {
        kind: 'team',
        total: 5,
        people: [
          { key: 'lead', name: 'Lead' },
          { key: 'senior', name: 'Senior Engineer' },
          { key: 'qa', name: 'QA' },
        ],
      },
      pullRequest: null,
      status: { attention: 'question', text: 'Waiting on you' },
      agentLabel: 'Dev Team',
      isTeam: true,
      boardCard: null,
      project: 'HoAE',
      projectColor: 'indigo',
    },
  },
};

export const Compact: Story = {
  args: { compact: true },
};

export const UnknownThread: Story = {
  args: {
    identity: bareThreadIdentity('A thread this view does not know'),
    onOpen: undefined,
  },
};
