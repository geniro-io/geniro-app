import type { Meta, StoryObj } from '@storybook/react-vite';

import { ThreadEventCard } from './thread-event-card';
import {
  type ThreadIdentity,
  ThreadIdentityContext,
  ThreadOpenContext,
} from './thread-title';

const IDENTITIES = new Map<string, ThreadIdentity>([
  [
    'r-ncdex',
    {
      title: 'NCDEX_IND: add agro commodities',
      project: 'PriceField',
      projectColor: 'orange',
      agentLabel: 'claude',
      isTeam: false,
    },
  ],
  [
    'r-elves',
    {
      title: 'Stage 5 — the Elves batch',
      project: 'HoAE',
      projectColor: 'indigo',
      agentLabel: 'Dev Team',
      isTeam: true,
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

export const Woken: Story = {
  args: { kind: 'woken', runId: 'r-elves', title: 'Stage 5' },
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
