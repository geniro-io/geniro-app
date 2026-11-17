import type { Meta, StoryObj } from '@storybook/react-vite';

import type { GraphThread, GraphThreadStatus } from './graph-view';
import { GraphView } from './graph-view';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const MINUTE = 60_000;

const MANAGER = { id: 'manager-run', label: 'Manager' };

const STATUSES: GraphThreadStatus[] = [
  'working',
  'waiting',
  'idle',
  'failed',
  'done',
];

function threadsOf(count: number): GraphThread[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `thread-${index + 1}`,
    label: `Thread ${index + 1}`,
    status: STATUSES[index % STATUSES.length]!,
  }));
}

const MIXED_THREADS = threadsOf(6);

const MIXED_CONTACTS = {
  'thread-1': {
    lastAt: new Date(NOW - 2 * MINUTE).toISOString(),
    awaitingReply: false,
  },
  'thread-2': {
    lastAt: new Date(NOW - 40 * MINUTE).toISOString(),
    awaitingReply: true,
  },
  'thread-3': {
    lastAt: new Date(NOW - 3 * MINUTE).toISOString(),
    awaitingReply: false,
  },
  'thread-4': { lastAt: null, awaitingReply: false },
  'thread-5': {
    lastAt: new Date(NOW - 90 * MINUTE).toISOString(),
    awaitingReply: false,
  },
};

const meta = {
  title: 'Command center/GraphView',
  component: GraphView,
  args: {
    manager: MANAGER,
    threads: MIXED_THREADS,
    contacts: MIXED_CONTACTS,
    pulses: [],
    now: NOW,
    onOpen: () => {},
  },
  decorators: [(story) => <div className="h-[460px] w-[640px]">{story()}</div>],
} satisfies Meta<typeof GraphView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No manager chat yet: the empty state line stands in for the graph. */
export const Empty: Story = {
  args: { manager: null, threads: [], contacts: {} },
};

/** Threads in every status, some lit by a recent contact, one idle with no contact at all. */
export const MixedStates: Story = {};

/** A thread that owes the manager a reply keeps its edge amber, even long after contact. */
export const AwaitingEdge: Story = {
  args: {
    threads: threadsOf(3),
    contacts: {
      'thread-1': {
        lastAt: new Date(NOW - 30 * MINUTE).toISOString(),
        awaitingReply: true,
      },
      'thread-2': {
        lastAt: new Date(NOW - MINUTE).toISOString(),
        awaitingReply: false,
      },
      'thread-3': { lastAt: null, awaitingReply: false },
    },
  },
};

/** Thirty threads: the graph draws the first 24 and one "+6 more" node. */
export const ThirtyThreads: Story = {
  args: {
    threads: threadsOf(30),
    contacts: Object.fromEntries(
      threadsOf(30).map((thread, index) => [
        thread.id,
        {
          lastAt: index % 3 === 0 ? new Date(NOW - MINUTE).toISOString() : null,
          awaitingReply: index % 7 === 0,
        },
      ]),
    ),
  },
};
