import type { Meta, StoryObj } from '@storybook/react-vite';

import { type FlagToolEntry, FlagToolRow } from './flag-tool-row';

const WORK: FlagToolEntry = {
  cost: 'work',
  category: 'geniro_tool',
  summary: 'move_stage refused a handoff whose stage was still open',
  detail:
    'Three retries, then the stage was moved by hand. The stage graph read the open stage as closed.',
  minutesLost: 15,
  handle: 'F-3fa9c1',
  refusal: null,
};

const meta = {
  title: 'Chats/FlagToolRow',
  component: FlagToolRow,
  args: { status: 'done', entry: WORK },
  decorators: [
    (story) => <div className="w-[560px] bg-background p-4">{story()}</div>,
  ],
} satisfies Meta<typeof FlagToolRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Work: Story = {};

export const Disagreement: Story = {
  args: {
    entry: {
      cost: 'disagreement',
      category: 'user_instructions',
      summary: 'Used npm after the user asked for pnpm',
      detail: null,
      minutesLost: null,
      handle: 'F-0a1b2c',
      refusal: null,
    },
  },
};

export const Pending: Story = {
  args: {
    status: 'running',
    entry: { ...WORK, handle: null },
  },
};

export const Refused: Story = {
  args: {
    status: 'error',
    entry: {
      ...WORK,
      handle: null,
      refusal: 'this conversation has used its flags.',
    },
  },
};
