import type { Meta, StoryObj } from '@storybook/react-vite';
import { GitPullRequest, MessageSquare, Play, ShieldAlert } from 'lucide-react';
import { fn } from 'storybook/test';

import { TimelineEventRow, type TimelineTone } from './timeline-event-row';
import { Button } from './ui/button';

const AT = new Date('2026-11-23T10:58:00').toISOString();

const TITLE = <span className="font-medium">Billing export</span>;
const STARTED = (
  <>
    {TITLE}
    <span className="shrink-0 whitespace-nowrap text-muted-foreground">
      started
    </span>
  </>
);

const meta = {
  title: 'Components/TimelineEventRow',
  component: TimelineEventRow,
  args: {
    icon: Play,
    tone: 'success',
    sentence: STARTED,
    at: AT,
  },
  decorators: [
    (story) => <ol className="flex w-[28rem] flex-col">{story()}</ol>,
  ],
} satisfies Meta<typeof TimelineEventRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Activatable: Story = {
  args: {
    onActivate: fn(),
    activateLabel: 'Show Billing export on the canvas',
  },
};

export const WithDetailBadgeAndActions: Story = {
  args: {
    icon: MessageSquare,
    tone: 'primary',
    sentence: (
      <>
        <span className="shrink-0 whitespace-nowrap">Manager →</span>
        {TITLE}
      </>
    ),
    badge: (
      <span className="shrink-0 rounded-pill bg-warning/10 px-1.5 text-[11px] text-warning">
        awaiting reply
      </span>
    ),
    detail:
      'Which bucket should the nightly export write to, and should it keep the last thirty days of files?',
    actions: (
      <span className="flex shrink-0 items-center">
        <Button type="button" variant="ghost" size="sm">
          Reply
        </Button>
      </span>
    ),
    onActivate: fn(),
    activateLabel: 'Show Billing export on the canvas',
  },
};

export const Live: Story = {
  args: {
    icon: GitPullRequest,
    tone: 'success',
    sentence: (
      <>
        {TITLE}
        <span className="shrink-0 whitespace-nowrap text-muted-foreground">
          opened PR #418
        </span>
      </>
    ),
    live: true,
  },
};

const TONES: readonly TimelineTone[] = [
  'primary',
  'success',
  'warning',
  'destructive',
  'accent',
  'muted',
];

export const Tones: Story = {
  args: { icon: ShieldAlert },
  render: (args) => (
    <>
      {TONES.map((tone) => (
        <TimelineEventRow
          key={tone}
          {...args}
          tone={tone}
          sentence={`${tone} row`}
        />
      ))}
    </>
  ),
};
