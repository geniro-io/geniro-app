import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bot, Folder, Users } from 'lucide-react';

import {
  BoardCardLabel,
  GoToThreadButton,
  PullRequestLabel,
  type ThreadAttention,
  ThreadLabelChip,
  ThreadLabelsRow,
  type ThreadPullRequestState,
  ThreadStatusChip,
} from './thread-labels';

const PULL_REQUEST_STATES: readonly (ThreadPullRequestState | null)[] = [
  'open',
  'draft',
  'merged',
  'closed',
  null,
];

const ATTENTIONS: readonly ThreadAttention[] = [
  'blocked',
  'working',
  'question',
  'quiet',
  'inactive',
  'done',
];

function ThreadLabels(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        {ATTENTIONS.map((attention) => (
          <ThreadStatusChip
            key={attention}
            attention={attention}
            slot="thread-status">
            {attention}
          </ThreadStatusChip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <BoardCardLabel
          card={{ identifier: 'MAN-16', title: 'Case page', status: 'todo' }}
        />
        <ThreadLabelChip
          slot="thread-agent"
          icon={Bot}
          text="claude"
          title="Agent claude"
          yields={false}
        />
        <ThreadLabelChip
          slot="thread-team"
          icon={Users}
          text="launch-crew"
          title="Team launch-crew"
          yields={false}
        />
        <ThreadLabelChip
          slot="thread-project"
          icon={Folder}
          text="ManifestOS"
          title="Project ManifestOS"
          yields
        />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {PULL_REQUEST_STATES.map((state, index) => (
          <PullRequestLabel
            key={state ?? 'unknown'}
            slot="thread-pull-request"
            pullRequest={{ number: 140 + index, state, url: null }}
          />
        ))}
      </div>
      <ThreadLabelsRow
        slot="thread"
        view={{
          status: { attention: 'working', text: 'Working' },
          agentLabel: 'Dev Team',
          isTeam: true,
          boardCard: { identifier: 'PRI-10', title: 'Agro', status: 'todo' },
          project: 'PriceField',
          projectColor: 'orange',
        }}
      />
      <div>
        <GoToThreadButton onGo={() => undefined} />
      </div>
    </div>
  );
}

const meta = {
  title: 'Components/ThreadLabels',
  component: ThreadLabels,
  decorators: [(story) => <div className="w-[480px]">{story()}</div>],
} satisfies Meta<typeof ThreadLabels>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllLabels: Story = {};
