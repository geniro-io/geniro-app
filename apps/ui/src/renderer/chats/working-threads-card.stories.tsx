import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';

import type { AvatarPerson } from '../components/member-avatar';
import { type WorkingThread, WorkingThreadsCard } from './working-threads-card';

const TEAM_PEOPLE: readonly AvatarPerson[] = [
  { key: 'lead', name: 'Nick Fury', avatar: { kind: 'emoji', value: '🛰️' } },
  { key: 'senior', name: 'Tony Stark', avatar: null },
  { key: 'middle', name: 'Peter Parker', avatar: null },
  { key: 'qa', name: 'Thanos', avatar: null },
];

function thread(over: Partial<WorkingThread>): WorkingThread {
  return {
    runId: 'run-1',
    title: 'Build the export button and its tests',
    agentLabel: 'Senior Engineer',
    agentKind: 'claude',
    crew: null,
    project: null,
    projectColor: null,
    lastMessage: null,
    status: 'working',
    ...over,
  };
}

const meta = {
  title: 'Chats/WorkingThreadsCard',
  component: WorkingThreadsCard,
  decorators: [
    (story) => (
      <div className="relative flex h-[520px] w-[720px] flex-col rounded-lg border border-border pb-10">
        <div className="min-h-0 flex-1" />
        {story()}
      </div>
    ),
  ],
  args: {
    beside: false,
    onOpenThread: () => {},
    threads: [
      thread({
        runId: 'run-1',
        project: 'Geniro',
        projectColor: 'teal',
        lastMessage: 'Export button wired; **two** specs left to write',
      }),
      thread({
        runId: 'run-2',
        title: 'Which CSV escaping does the export library apply?',
        agentLabel: 'Researcher',
        agentKind: 'cursor-agent',
        status: 'waiting',
        lastMessage: 'Checking the library source for its quoting rules',
      }),
      thread({
        runId: 'run-3',
        title: 'Draft the release notes for the export feature',
        agentLabel: 'dev-team',
        agentKind: null,
        crew: { people: TEAM_PEOPLE, total: 6 },
        project: 'Docs',
        projectColor: 'purple',
        lastMessage: 'Waiting on the QA plan before the notes go out',
      }),
    ],
  },
} satisfies Meta<typeof WorkingThreadsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const pinPanel: Story['play'] = async ({ canvasElement }) => {
  await userEvent.click(
    within(canvasElement).getByRole('button', { name: /^Threads working · / }),
  );
};

export const Working: Story = {};

export const Pinned: Story = { play: pinPanel };

export const BesideAgentsCard: Story = {
  args: { beside: true },
  decorators: [
    (story) => (
      <>
        {story()}
        <div
          aria-hidden="true"
          className="absolute right-4 -bottom-2 size-8 rounded-full border border-border bg-popover shadow-panel-lg"
        />
      </>
    ),
  ],
};
