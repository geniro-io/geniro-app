import type { Meta, StoryObj } from '@storybook/react-vite';

import { TeamNoteRow } from './team-note-row';

const meta = {
  title: 'Chats/TeamNoteRow',
  component: TeamNoteRow,
  args: {
    author: 'Backend Engineer',
    note: {
      kind: 'contract',
      text: '`POST /orders` returns `{ id, status }`; `status` is one of `pending`, `paid`, `failed`.',
      supersedes: null,
      nodeId: 'engineer',
      conversationId: 'call-3',
      callId: 'call-3',
    },
  },
  decorators: [
    (story) => <div className="w-[560px] bg-background p-4">{story()}</div>,
  ],
} satisfies Meta<typeof TeamNoteRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Contract: Story = {};

export const PitfallReplacingAnEarlierNote: Story = {
  args: {
    note: {
      kind: 'pitfall',
      text: '`npm ci` fails in this repo (pnpm workspace). Use `pnpm install --frozen-lockfile`, then `pnpm rebuild:native`.',
      supersedes: 190,
      nodeId: 'engineer',
      conversationId: null,
      callId: null,
    },
  },
};

export const UnderItsAuthor: Story = {
  args: { author: null },
};
