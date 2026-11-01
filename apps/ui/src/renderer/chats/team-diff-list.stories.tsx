import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  RECORDED_REPLACE_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL,
  STAGES_PROPOSAL,
} from '../__fixtures__/team-proposals';
import { TeamDiffList } from './team-diff-list';
import { diffRows, readTeamProposal } from './team-proposal-payload';

function rowsOf(input: unknown) {
  const proposal = readTeamProposal(input)!;
  return diffRows(proposal.diff!, proposal.team);
}

const meta = {
  title: 'Chats/TeamDiffList',
  component: TeamDiffList,
  args: { rows: rowsOf(REPLACE_TO_AUTO_PROPOSAL) },
  decorators: [(story) => <div className="w-[520px]">{story()}</div>],
} satisfies Meta<typeof TeamDiffList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two agents now run without asking: listed first, tinted and named. */
export const ToAuto: Story = {};

/** The recorded replacement: one agent goes back to asking. */
export const OneChange: Story = {
  args: { rows: rowsOf(RECORDED_REPLACE_PROPOSAL) },
};

/** A builder chat's stage change: one stage added, one rewired, one removed. */
export const Stages: Story = {
  args: { rows: rowsOf(STAGES_PROPOSAL) },
};

export const Identical: Story = { args: { rows: [] } };

/** A rewritten role: the two sides are quoted from where they differ, one under the other. */
export const LongText: Story = {
  args: {
    rows: [
      {
        key: 'changed:manager:role',
        marker: 'changed',
        scope: 'node',
        subject: 'manager',
        detail: {
          field: 'role',
          before:
            '…route it, keep it moving until it is DONE, and report the result. Never push to main; every change goes through a pull request the user reviews…',
          after:
            '…route it, keep it moving until it is DONE, and report the result. Before you report, save at most three verified notes to the team memory, then…',
        },
        toAuto: false,
      },
    ],
  },
};
