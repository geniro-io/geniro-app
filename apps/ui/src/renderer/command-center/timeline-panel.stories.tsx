import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ThreadArchiveContext } from '../components/thread-archive';
import { TIMELINE_FIXTURE_NOW, timelineFixtures } from './timeline-fixtures';
import { TimelinePanel } from './timeline-panel';

const ASKED_ITEM = 'item-billing-export';
const archiveRelease = fn();

const meta = {
  title: 'Command center/Timeline',
  component: TimelinePanel,
  args: {
    events: timelineFixtures(),
    loading: false,
    error: null,
    hasMore: true,
    onLoadOlder: () => {},
    onShowThread: fn(),
    onReply: fn(),
    openItemIds: new Set<string>(),
    now: TIMELINE_FIXTURE_NOW,
  },
  decorators: [
    (story) => (
      <div className="h-[640px] w-[380px] overflow-hidden rounded-card border border-border">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof TimelinePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllKinds: Story = {
  args: { hasMore: false },
};

export const Narrow: Story = {
  decorators: [
    (story) => (
      <div className="h-[640px] w-[320px] overflow-hidden rounded-card border border-border">
        {story()}
      </div>
    ),
  ],
};

export const ReplyAndArchive: Story = {
  args: {
    events: timelineFixtures().map((event) =>
      event.kind === 'question'
        ? { ...event, id: `question:${ASKED_ITEM}` }
        : event,
    ),
    openItemIds: new Set([ASKED_ITEM]),
  },
  decorators: [
    (story) => (
      <ThreadArchiveContext.Provider
        value={(runId) => (runId === 'run-release' ? archiveRelease : null)}>
        {story()}
      </ThreadArchiveContext.Provider>
    ),
  ],
};

export const LoadingOlder: Story = {
  args: { loading: true },
};

export const Loading: Story = {
  args: { events: [], loading: true, hasMore: false },
};

export const Empty: Story = {
  args: { events: [], hasMore: false },
};

export const LoadFailed: Story = {
  args: {
    events: [],
    hasMore: false,
    error: 'Could not load the timeline: the daemon answered 500.',
  },
};

export const ErrorOverEvents: Story = {
  args: {
    error: 'Could not load older events: the daemon answered 500.',
  },
};
