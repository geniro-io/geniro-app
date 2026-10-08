import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';

import { AgentPoolLabel } from './agent-pool-label';

const meta = {
  title: 'Components/AgentPoolLabel',
  component: AgentPoolLabel,
  args: {
    members: [
      { name: 'claude', model: 'opus', profile: '/Users/me/.claude-work' },
      {
        name: 'codex',
        model: 'gpt-6.1-sol',
        profile: '/Users/me/.codex-manifest-lab',
      },
    ],
  },
  decorators: [
    (story) => (
      <div className="flex h-48 w-80 items-start justify-end pt-4 pr-4">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof AgentPoolLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A pool: the first member's CLI plus a count; a press pins the member list. */
export const Pool: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: /agent pool/i }),
    );
  },
};

/** One agent with no pool is a plain badge — nothing to list. */
export const SingleAgent: Story = {
  args: { members: [{ name: 'cursor', model: 'composer-2.5' }] },
};

export const ThreeMembers: Story = {
  args: {
    members: [
      { name: 'claude', model: 'opus' },
      { name: 'codex', model: 'gpt-6.1-sol' },
      { name: 'cursor', model: null },
    ],
  },
};
