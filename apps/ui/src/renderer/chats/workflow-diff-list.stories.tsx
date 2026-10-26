import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  RECORDED_REPLACE_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL,
} from '../__fixtures__/workflow-proposals';
import { WorkflowDiffList } from './workflow-diff-list';
import { diffRows, readWorkflowProposal } from './workflow-proposal-payload';

function rowsOf(input: unknown) {
  const proposal = readWorkflowProposal(input)!;
  return diffRows(proposal.diff!, proposal.workflow);
}

const meta = {
  title: 'Chats/WorkflowDiffList',
  component: WorkflowDiffList,
  args: { rows: rowsOf(REPLACE_TO_AUTO_PROPOSAL) },
  decorators: [(story) => <div className="w-[520px]">{story()}</div>],
} satisfies Meta<typeof WorkflowDiffList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two agents now run without asking: listed first, tinted and named. */
export const ToAuto: Story = {};

/** The recorded replacement: one agent goes back to asking. */
export const OneChange: Story = {
  args: { rows: rowsOf(RECORDED_REPLACE_PROPOSAL) },
};

export const Identical: Story = { args: { rows: [] } };
