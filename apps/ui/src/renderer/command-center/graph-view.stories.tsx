import type { Meta, StoryObj } from '@storybook/react-vite';

import { FIXTURE_NOW, graphThreadsOf } from './graph-fixtures';
import { GraphView } from './graph-view';

const MINUTE = 60_000;

const MIXED_CONTACTS = {
  'thread-1': {
    lastAt: new Date(FIXTURE_NOW - 2 * MINUTE).toISOString(),
    awaitingReply: false,
  },
  'thread-2': {
    lastAt: new Date(FIXTURE_NOW - 40 * MINUTE).toISOString(),
    awaitingReply: true,
  },
  'thread-3': {
    lastAt: new Date(FIXTURE_NOW - 3 * MINUTE).toISOString(),
    awaitingReply: false,
  },
  'thread-4': { lastAt: null, awaitingReply: false },
};

const meta = {
  title: 'Command center/GraphView',
  component: GraphView,
  args: {
    managerStarted: true,
    threads: graphThreadsOf(5),
    contacts: MIXED_CONTACTS,
    pulses: [],
    now: FIXTURE_NOW,
    narrow: false,
    onOpen: () => {},
    onManager: () => {},
    className: 'h-full',
  },
  decorators: [
    (story) => <div className="h-[560px] w-[1100px]">{story()}</div>,
  ],
} satisfies Meta<typeof GraphView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The manager on top, five threads under it: one lit, one amber awaiting a reply, the rest quiet. */
export const ManagerAndThreads: Story = {};

/** No manager chat yet: its node still heads the tree and opens it on a press. */
export const ManagerNotStarted: Story = {
  args: { managerStarted: false, contacts: {} },
};

/** Thirty threads: the graph draws the 24 most recently active and one "+6 more" node. */
export const ThirtyThreads: Story = {
  args: { threads: graphThreadsOf(30), contacts: {} },
};

/** A phone: one column, the manager first and each thread indented under it. */
export const Phone: Story = {
  args: { narrow: true },
  decorators: [(story) => <div className="h-[700px] w-[390px]">{story()}</div>],
};
