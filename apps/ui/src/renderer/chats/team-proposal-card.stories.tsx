import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import {
  MOVE_TO_PROJECT_PROPOSAL,
  OVERLAY_ONLY_PROPOSAL,
  RECORDED_NEW_PROPOSAL,
  RECORDED_REPLACE_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL,
  REPLACE_WITH_OVERLAY_PROPOSAL,
  RUN_CHANGE_PROPOSAL,
  RUN_START_PROPOSAL,
  STAGES_PROPOSAL,
} from './__fixtures__/member-team-proposals';
import { ApprovalCard } from './approval-card';
import { PROPOSE_TEAM, RUN_TEAM } from './geniro-tool';
import { QueuedMessagesContext } from './queued-messages-context';

/**
 * Drawn through `ApprovalCard`, the router every `approval_request` row goes
 * through, so the unparseable story shows the real fallback.
 */
const meta = {
  title: 'Chats/TeamProposalCard',
  component: ApprovalCard,
  args: {
    toolName: PROPOSE_TEAM,
    input: RECORDED_NEW_PROPOSAL,
    verdict: null,
    requestId: 'story',
    onRespond: fn(),
    onOpenTeam: fn(),
  },
  decorators: [(story) => <div className="w-[640px]">{story()}</div>],
} satisfies Meta<typeof ApprovalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A recorded new team: one agent runs without asking. */
export const PendingNew: Story = {};

/** A replacement that switches two agents to running unasked. */
export const PendingReplaceWithAuto: Story = {
  args: { input: REPLACE_TO_AUTO_PROPOSAL },
};

/** A builder chat's stage change: the walk it proposes and each stage it touches. */
export const PendingStages: Story = {
  args: { input: STAGES_PROPOSAL },
};

/** A replacement that also changes one project's overlay of the team. */
export const PendingReplaceWithOverlay: Story = {
  args: { input: REPLACE_WITH_OVERLAY_PROPOSAL },
};

/** Only the project's overlay changes; the shared team section is left out. */
export const PendingOverlayOnly: Story = {
  args: { input: OVERLAY_ONLY_PROPOSAL },
};

/** Text moves from the team into a project's instructions, written by the same Approve. */
export const PendingMoveToProject: Story = {
  args: { input: MOVE_TO_PROJECT_PROPOSAL },
};

export const SettledSaved: Story = {
  args: {
    verdict: true,
    outcome: { kind: 'saved', slug: 'review-pair' },
  },
};

/** The recorded replacement, declined with a note. */
export const Declined: Story = {
  args: {
    input: RECORDED_REPLACE_PROPOSAL,
    verdict: false,
    answer: 'Keep the reviewer on auto for now.',
  },
};

export const NotSaved: Story = {
  args: {
    input: REPLACE_TO_AUTO_PROPOSAL,
    verdict: true,
    outcome: { kind: 'not-saved', cause: 'changed' },
  },
};

/** A payload this build cannot read falls back to the permission body. */
export const Unparseable: Story = {
  args: { input: { mode: 'replace', slug: 'review-pair', team: 'oops' } },
};

/** A run_team start card: this chat becomes the team, its own agent the lead. */
export const PendingRunStart: Story = {
  args: { toolName: RUN_TEAM, input: RUN_START_PROPOSAL },
};

/** Start waits while this chat's composer queue holds messages. */
export const PendingRunStartQueued: Story = {
  args: { toolName: RUN_TEAM, input: RUN_START_PROPOSAL },
  decorators: [
    (story) => (
      <QueuedMessagesContext.Provider value={2}>
        {story()}
      </QueuedMessagesContext.Provider>
    ),
  ],
};

/** A run_team change card: one agent joins, one leaves, one changes. */
export const PendingRunChange: Story = {
  args: { toolName: RUN_TEAM, input: RUN_CHANGE_PROPOSAL },
};

export const RunStarted: Story = {
  args: {
    toolName: RUN_TEAM,
    input: RUN_START_PROPOSAL,
    verdict: true,
    outcome: { kind: 'started' },
  },
};

export const RunNotStarted: Story = {
  args: {
    toolName: RUN_TEAM,
    input: RUN_START_PROPOSAL,
    verdict: true,
    outcome: {
      kind: 'not-started',
      causes: ['a turn is still running', 'two agents are named Coder'],
    },
  },
};

export const RunChangeApplied: Story = {
  args: {
    toolName: RUN_TEAM,
    input: RUN_CHANGE_PROPOSAL,
    verdict: true,
    outcome: { kind: 'changed' },
  },
};

export const RunChangeNotApplied: Story = {
  args: {
    toolName: RUN_TEAM,
    input: RUN_CHANGE_PROPOSAL,
    verdict: true,
    outcome: {
      kind: 'not-changed',
      reason: 'the running team changed after this was proposed',
    },
  },
};
