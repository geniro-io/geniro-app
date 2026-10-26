import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import {
  RECORDED_NEW_PROPOSAL,
  RECORDED_REPLACE_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL,
} from '../__fixtures__/workflow-proposals';
import { ApprovalCard } from './approval-card';
import { PROPOSE_WORKFLOW } from './geniro-tool';

/**
 * Drawn through `ApprovalCard`, the router every `approval_request` row goes
 * through, so the unparseable story shows the real fallback.
 */
const meta = {
  title: 'Chats/WorkflowProposalCard',
  component: ApprovalCard,
  args: {
    toolName: PROPOSE_WORKFLOW,
    input: RECORDED_NEW_PROPOSAL,
    verdict: null,
    requestId: 'story',
    onRespond: fn(),
    onOpenWorkflow: fn(),
  },
  decorators: [(story) => <div className="w-[640px]">{story()}</div>],
} satisfies Meta<typeof ApprovalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A recorded new workflow: one agent runs without asking. */
export const PendingNew: Story = {};

/** A replacement that switches two agents to running unasked. */
export const PendingReplaceWithAuto: Story = {
  args: { input: REPLACE_TO_AUTO_PROPOSAL },
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
  args: { input: { mode: 'replace', slug: 'review-pair', workflow: 'oops' } },
};
