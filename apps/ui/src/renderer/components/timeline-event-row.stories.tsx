import type { Meta, StoryObj } from '@storybook/react-vite';
import { GitPullRequest, MessageSquare, Play, ShieldAlert } from 'lucide-react';
import { fn } from 'storybook/test';

import { TimelineEventRow, type TimelineTone } from './timeline-event-row';
import { Badge } from './ui/badge';
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
    sentence: TITLE,
    meta: (
      <>
        <span className="shrink-0 whitespace-nowrap">
          Message from the Manager
        </span>
        <Badge
          variant="warning"
          className="shrink-0 px-1.5 py-0 text-[11px] font-normal">
          awaiting reply
        </Badge>
      </>
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

export const WithMeta: Story = {
  args: {
    sentence: (
      <>
        <Badge
          variant="muted"
          className="shrink-0 px-1.5 py-0 font-mono font-normal">
          GEN-409
        </Badge>
        <span className="min-w-0 truncate font-medium">
          Fix the login redirect
        </span>
      </>
    ),
    meta: (
      <>
        <span data-slot="timeline-project" className="min-w-0 truncate">
          Geniro
        </span>
        {' · '}
        <span className="shrink-0 whitespace-nowrap">started</span>
      </>
    ),
    onActivate: fn(),
    activateLabel: 'Show Fix the login redirect on the canvas',
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
