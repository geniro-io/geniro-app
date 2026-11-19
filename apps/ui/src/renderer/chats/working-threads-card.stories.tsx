import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';

import type { AvatarPerson } from '../components/member-avatar';
import {
  bareThreadIdentity,
  type ThreadIdentity,
} from '../components/thread-head';
import { type WorkingThread, WorkingThreadsCard } from './working-threads-card';

const TEAM_PEOPLE: readonly AvatarPerson[] = [
  { key: 'lead', name: 'Nick Fury', avatar: { kind: 'emoji', value: '🛰️' } },
  { key: 'senior', name: 'Tony Stark', avatar: null },
  { key: 'middle', name: 'Peter Parker', avatar: null },
  { key: 'qa', name: 'Thanos', avatar: null },
];

const AGENT: ThreadIdentity = {
  ...bareThreadIdentity('Build the export button and its tests'),
  face: { kind: 'agent', icon: 'terminal', name: 'claude' },
  status: { attention: 'working', text: 'Working' },
  agentLabel: 'claude',
};

function thread(
  over: Partial<Omit<WorkingThread, 'identity'>> & {
    identity?: Partial<ThreadIdentity>;
  },
): WorkingThread {
  return {
    runId: 'run-1',
    status: 'working',
    lastMessage: null,
    lastAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    background: { held: false, subagents: 0, commands: 0 },
    ...over,
    identity: { ...AGENT, ...over.identity },
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
    onOpenHere: () => {},
    threads: [
      thread({
        runId: 'run-1',
        identity: {
          project: 'Geniro',
          projectColor: 'teal',
          pullRequest: { number: 146, state: 'draft' },
          boardCard: { identifier: 'GEN-12', title: 'Export', status: 'todo' },
        },
        background: { held: false, subagents: 2, commands: 0 },
        lastMessage: 'Export button wired; **two** specs left to write',
      }),
      thread({
        runId: 'run-2',
        status: 'waiting',
        identity: {
          title: 'Which CSV escaping does the export library apply?',
          face: { kind: 'agent', icon: 'code', name: 'cursor' },
          status: { attention: 'question', text: 'Waiting on you' },
          agentLabel: 'cursor',
        },
        lastMessage: 'Checking the library source for its quoting rules',
      }),
      thread({
        runId: 'run-3',
        identity: {
          title: 'Draft the release notes for the export feature',
          face: { kind: 'team', people: TEAM_PEOPLE, total: 6 },
          agentLabel: 'dev-team',
          isTeam: true,
          project: 'Docs',
          projectColor: 'purple',
        },
        background: { held: true, subagents: 0, commands: 1 },
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

const MANY_THREADS: readonly WorkingThread[] = Array.from(
  { length: 10 },
  (_, index) =>
    thread({
      runId: `run-many-${index}`,
      status: index % 3 === 0 ? 'waiting' : 'working',
      identity: {
        title: `Export follow-up ${index + 1}: wire the CSV escaping and its specs to the new button`,
      },
      lastMessage: 'Still running the checks for this branch',
    }),
);

export const ManyThreadsPinned: Story = {
  args: { threads: MANY_THREADS },
  play: pinPanel,
};

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
