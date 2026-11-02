import type { Meta, StoryObj } from '@storybook/react-vite';

import { HeldProblems } from './held-problems';

const meta = {
  title: 'Teams/HeldProblems',
  component: HeldProblems,
  args: {
    slot: 'team-problems',
    problems: [
      'Choose the member that handles the first message',
      'A member needs a name',
    ],
  },
  decorators: [(story) => <div className="w-[480px]">{story()}</div>],
} satisfies Meta<typeof HeldProblems>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Problems: Story = {};

export const WithFixes: Story = {
  args: {
    role: 'status',
    problems: [
      {
        key: 'cli',
        level: 'error',
        message: 'The CLI is not installed on this Mac',
        fix: { label: 'Open Settings', run: () => {} },
      },
      {
        key: 'signed-out',
        level: 'warning',
        message: 'Signed out of its CLI',
        fix: { label: 'Sign in', run: () => {} },
      },
    ],
  },
};

export const WarningsOnly: Story = {
  args: {
    problems: [
      {
        key: 'mcp',
        level: 'warning',
        message: 'The “github” server did not connect',
        fix: { label: 'Open MCP', run: () => {} },
      },
    ],
  },
};

export const Nothing: Story = { args: { problems: [] } };
