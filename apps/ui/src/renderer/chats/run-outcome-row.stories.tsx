import type { Meta, StoryObj } from '@storybook/react-vite';

import { RunOutcomeRow } from './run-outcome-row';

const meta = {
  title: 'Chats/RunOutcomeRow',
  component: RunOutcomeRow,
  args: {
    author: 'Manager',
    superseded: false,
    showRepo: false,
    outcome: {
      prOwner: 'acme',
      prRepo: 'platform',
      prNumber: 7381,
      prUrl: 'https://github.com/acme/platform/pull/7381',
      draft: true,
      reviewRounds: 2,
      acceptance: 'accepted',
      questionsAsked: 3,
      nodeId: 'manager',
    },
  },
  decorators: [
    (story) => <div className="w-[560px] bg-background p-4">{story()}</div>,
  ],
} satisfies Meta<typeof RunOutcomeRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Accepted: Story = {};

export const ChangesRequested: Story = {
  args: {
    outcome: {
      ...meta.args.outcome,
      draft: false,
      reviewRounds: 1,
      acceptance: 'changes_requested',
      questionsAsked: 1,
    },
  },
};

export const NotYetWithNoRoundsOrQuestions: Story = {
  args: {
    outcome: {
      ...meta.args.outcome,
      reviewRounds: 0,
      acceptance: 'not_yet',
      questionsAsked: 0,
    },
  },
};

export const NotNeeded: Story = {
  args: {
    outcome: { ...meta.args.outcome, acceptance: 'not_needed' },
  },
};

export const SupersededInAMultiRepoThread: Story = {
  args: { superseded: true, showRepo: true, author: null },
};
