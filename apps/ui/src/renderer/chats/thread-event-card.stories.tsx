import type { Meta, StoryObj } from '@storybook/react-vite';

import type { ThreadIdentity } from '../components/thread-head';
import { ThreadEventCard } from './thread-event-card';
import { ThreadIdentityContext, ThreadOpenContext } from './thread-title';

const PEOPLE = [
  { key: 'lead', name: 'Lead' },
  { key: 'senior', name: 'Senior Engineer' },
  { key: 'qa', name: 'QA' },
];

const IDENTITIES = new Map<string, ThreadIdentity>([
  [
    'r-ncdex',
    {
      title: 'NCDEX_IND: add agro commodities',
      face: { kind: 'agent', icon: 'terminal', name: 'claude' },
      pullRequest: { number: 146, state: 'open' },
      status: { attention: 'working', text: 'Working' },
      agentLabel: 'claude',
      isTeam: false,
      boardCard: {
        identifier: 'PRI-10',
        title: 'Agro commodities',
        status: 'in_progress',
      },
      project: 'PriceField',
      projectColor: 'orange',
    },
  ],
  [
    'r-elves',
    {
      title: 'Stage 5 — the Elves batch',
      face: { kind: 'team', people: PEOPLE, total: 5 },
      pullRequest: null,
      status: { attention: 'question', text: 'Waiting on you' },
      agentLabel: 'Dev Team',
      isTeam: true,
      boardCard: null,
      project: 'HoAE',
      projectColor: 'indigo',
    },
  ],
  [
    'r-manager',
    {
      title: 'Manager',
      face: { kind: 'manager' },
      pullRequest: null,
      status: { attention: 'quiet', text: 'Idle' },
      agentLabel: 'claude',
      isTeam: false,
      boardCard: null,
      project: null,
      projectColor: null,
    },
  ],
]);

const meta = {
  title: 'Chats/ThreadEventCard',
  component: ThreadEventCard,
  args: {
    kind: 'sent',
    runId: 'r-ncdex',
    title: 'NCDEX_IND',
  },
  decorators: [
    (story) => (
      <div className="w-[560px] bg-background p-3 text-foreground">
        <ThreadOpenContext.Provider value={() => {}}>
          <ThreadIdentityContext.Provider value={IDENTITIES}>
            {story()}
          </ThreadIdentityContext.Provider>
        </ThreadOpenContext.Provider>
      </div>
    ),
  ],
} satisfies Meta<typeof ThreadEventCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Sent: Story = {
  args: {
    kind: 'sent',
    text: 'The user decided: leave the source inactive and cancel this task. Close the PR with a comment and move the card to done.',
    outcome: 'Started a turn there',
  },
};

export const Received: Story = {
  args: {
    kind: 'received',
    runId: 'r-elves',
    title: 'Stage 5',
    member: 'Senior Engineer',
    inReplyTo: 'Are the stalls approved?',
    text: 'Stalls approved and your answer recorded. Three stalls are being finished: form, textures, the market sign.',
  },
};

export const LongMarkdownReply: Story = {
  args: {
    kind: 'received',
    runId: 'r-elves',
    title: 'Stage 5',
    inReplyTo: 'Hold the Elves batch until the stage 4 review lands.',
    text: [
      '## Stage 5 — review of the Elves batch',
      '',
      'The batch is **staged** and every check has run:',
      '',
      '1. Textures: 42 of 42 converted.',
      '2. Stalls: form, textures and the market sign are finished.',
      '3. Pathing: two NPCs still clip the fountain.',
      '',
      '```ts',
      'const report = await batch.verify({ stage: 5, strict: true });',
      '```',
      '',
      '| Check | Result |',
      '| --- | --- |',
      '| Textures | passed |',
      '| Pathing | 2 failures |',
      '',
      'Tell me if you want the NPC fix in this batch or the next one.',
    ].join('\n'),
  },
};

export const Woken: Story = {
  args: { kind: 'woken', runId: 'r-elves', title: 'Stage 5' },
};

export const FromTheManager: Story = {
  args: {
    kind: 'received',
    runId: 'r-manager',
    title: 'Command center manager',
    text: 'The user decided: leave the source inactive and cancel this task. Keep the PR open for review.',
  },
};

export const Done: Story = {
  args: {
    kind: 'done',
    handle: 't22',
    pullRequest: 146,
    text: 'PRI-10 cancelled. Key attempts stopped, PR #146 closed unmerged with a comment, the board card moved to done.',
  },
};

export const UnknownThread: Story = {
  args: {
    kind: 'received',
    runId: 'r-unknown',
    title: 'A thread this view does not know',
    text: 'Drawn neutral: no project colour, the title the row recorded.',
  },
};
