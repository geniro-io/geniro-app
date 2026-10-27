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
      summary: null,
      nodeId: 'manager',
    },
    recordedAt: '2026-10-27T14:31:00',
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
      summary:
        'The user wants the upload retry moved behind a feature flag before it ships.',
    },
  },
};

export const WithGitHubDetails: Story = {
  args: {
    outcome: {
      ...meta.args.outcome,
      summary:
        'Adds resumable uploads; the user accepted it after one review round.',
    },
    pullRequest: {
      ref: {
        owner: 'acme',
        repo: 'platform',
        number: 7381,
        url: 'https://github.com/acme/platform/pull/7381',
      },
      pullRequest: {
        number: 7381,
        title: 'feat(upload): resumable uploads with retry',
        state: 'open',
        isDraft: true,
        headRefName: 'resumable-uploads',
        isCrossRepository: false,
        headRepositoryOwner: 'acme',
        author: 'octo',
        url: 'https://github.com/acme/platform/pull/7381',
        updatedAt: '2026-10-27T14:00:00Z',
        added: 412,
        removed: 38,
        changedFiles: 9,
      },
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
