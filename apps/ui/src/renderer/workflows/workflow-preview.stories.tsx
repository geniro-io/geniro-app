import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  RECORDED_NEW_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL,
} from '../__fixtures__/workflow-proposals';
import {
  previewMarks,
  readWorkflowProposal,
} from '../chats/workflow-proposal-payload';
import WorkflowPreview from './workflow-preview';

const created = readWorkflowProposal(RECORDED_NEW_PROPOSAL)!;
const replaced = readWorkflowProposal(REPLACE_TO_AUTO_PROPOSAL)!;

const meta = {
  title: 'Workflows/WorkflowPreview',
  component: WorkflowPreview,
  args: { workflow: created.workflow },
  decorators: [
    (story) => (
      <div className="h-[260px] w-[560px] rounded-md border border-border bg-card">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A new team: the reviewer runs without asking, so it is ringed and named. */
export const NewWorkflow: Story = {};

/** A replacement: added and changed nodes marked against the saved workflow. */
export const Replacement: Story = {
  args: {
    workflow: replaced.workflow,
    marks: previewMarks(replaced.diff),
  },
};

/** The enlarged dialog's reading: pan and zoom allowed. */
export const Interactive: Story = {
  args: { workflow: replaced.workflow, interactive: true },
};
