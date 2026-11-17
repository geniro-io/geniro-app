import type { Meta, StoryObj } from '@storybook/react-vite';

import { ThreadCard } from './thread-card';

const meta = {
  title: 'Command center/ThreadCard',
  component: ThreadCard,
  args: {
    title: 'Fix the login redirect',
    status: 'working',
    handle: 't1',
    project: 'Geniro',
    agentLabel: 'Claude Code',
    pullRequest: null,
    note: null,
    activity: 'running the **test suite**',
    boardCard: null,
    idleDays: null,
    onGo: () => {},
  },
  decorators: [(story) => <div className="p-4">{story()}</div>],
} satisfies Meta<typeof ThreadCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = {};

/** A thread that works a board card wears it as a label. */
export const WithBoardCard: Story = {
  args: {
    boardCard: {
      identifier: 'GEN-412',
      title: 'Fix the login redirect',
      status: 'in_progress',
    },
  },
};

/** Nobody has touched it for days: the idle mark says how many. */
export const IdleForDays: Story = {
  args: { status: 'idle', activity: null, idleDays: 6 },
};

export const WaitingOnYou: Story = {
  args: {
    status: 'waiting',
    title: 'Pick the migration strategy',
    activity: null,
  },
};

export const Failed: Story = {
  args: { status: 'failed', title: 'Release notes', activity: null },
};

export const WithPullRequestAndNote: Story = {
  args: {
    title: 'Wire the thread-start conductor',
    pullRequest: { number: 417, state: 'draft' },
    note: 'Waiting for the other thread to land its migration first.',
    boardCard: {
      identifier: 'GEN-417',
      title: 'Conductor',
      status: 'in_review',
    },
  },
};

export const LongTitle: Story = {
  args: {
    title:
      'Investigate why the sidebar resets its scroll position whenever a background agent posts a status line into a thread the user is not reading right now',
  },
};
