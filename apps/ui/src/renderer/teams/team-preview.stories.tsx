import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  RECORDED_NEW_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL,
} from '../__fixtures__/team-proposals';
import { previewMarks, readTeamProposal } from '../chats/team-proposal-payload';
import TeamPreview from './team-preview';

const created = readTeamProposal(RECORDED_NEW_PROPOSAL)!;
const replaced = readTeamProposal(REPLACE_TO_AUTO_PROPOSAL)!;

const meta = {
  title: 'Teams/TeamPreview',
  component: TeamPreview,
  args: { team: created.team },
  decorators: [
    (story) => (
      <div className="h-[260px] w-[560px] rounded-md border border-border bg-card">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof TeamPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A new team: the reviewer runs without asking, so it is ringed and named. */
export const NewTeam: Story = {};

/** A replacement: added and changed nodes marked against the saved team. */
export const Replacement: Story = {
  args: {
    team: replaced.team,
    marks: previewMarks(replaced.diff),
  },
};

/** A chat card's reading: drag to pan, pinch or the buttons to zoom. */
export const Embedded: Story = {
  args: { team: replaced.team, interaction: 'embedded' },
};

/** The enlarged dialog's reading: the wheel zooms too. */
export const Interactive: Story = {
  args: { team: replaced.team, interaction: 'full' },
};
