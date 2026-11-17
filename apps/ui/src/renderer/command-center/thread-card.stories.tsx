import type { Meta, StoryObj } from '@storybook/react-vite';

import { ThreadCard } from './thread-card';

const STRIP = {
  start: '2026-11-17T06:00:00.000Z',
  end: '2026-11-17T14:00:00.000Z',
  spans: [
    {
      kind: 'work' as const,
      start: '2026-11-17T06:30:00.000Z',
      end: '2026-11-17T08:10:00.000Z',
    },
    {
      kind: 'waiting' as const,
      start: '2026-11-17T08:10:00.000Z',
      end: '2026-11-17T09:00:00.000Z',
    },
    { kind: 'work' as const, start: '2026-11-17T09:00:00.000Z', end: null },
  ],
  markers: [
    {
      kind: 'user_message' as const,
      at: '2026-11-17T06:20:00.000Z',
      label: 'Fix the login redirect',
    },
    {
      kind: 'question' as const,
      at: '2026-11-17T08:10:00.000Z',
      label: 'Which branch?',
    },
    {
      kind: 'pr_opened' as const,
      at: '2026-11-17T09:30:00.000Z',
      label: 'PR 412',
    },
  ],
};

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
    strip: STRIP,
    task: null,
    onOpen: () => {},
  },
  decorators: [(story) => <div className="p-4">{story()}</div>],
} satisfies Meta<typeof ThreadCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = {};

/** A thread working a board card: the toggle folds the card under it in the graph. */
export const WithBoardCard: Story = {
  args: { task: { expanded: false, onToggle: () => {} } },
};

export const WithBoardCardUnfolded: Story = {
  args: { task: { expanded: true, onToggle: () => {} } },
};

export const WaitingOnYou: Story = {
  args: {
    status: 'waiting',
    title: 'Pick the migration strategy',
    activity: null,
  },
};

export const Idle: Story = {
  args: { status: 'idle', activity: null },
};

export const Failed: Story = {
  args: {
    status: 'failed',
    title: 'Release notes',
    activity: null,
  },
};

export const Done: Story = {
  args: {
    status: 'done',
    title: 'Rename the settings page',
    pullRequest: { number: 409, state: 'merged' },
    activity: null,
  },
};

export const LongTitle: Story = {
  args: {
    title:
      'Investigate why the sidebar resets its scroll position whenever a background agent posts a status line into a thread the user is not reading right now',
  },
};

export const WithPullRequestAndNote: Story = {
  args: {
    title: 'Wire the thread-start conductor',
    pullRequest: { number: 417, state: 'draft' },
    note: 'Waiting for the other thread to land its migration first.',
  },
};

export const EmptyStrip: Story = {
  args: {
    title: 'A thread that has not started yet',
    status: 'idle',
    activity: null,
    strip: {
      start: '2026-11-17T06:00:00.000Z',
      end: '2026-11-17T14:00:00.000Z',
      spans: [],
      markers: [],
    },
  },
};
