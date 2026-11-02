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

export const Nothing: Story = { args: { problems: [] } };
