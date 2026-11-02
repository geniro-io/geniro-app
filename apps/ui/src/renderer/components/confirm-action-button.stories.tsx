import type { Meta, StoryObj } from '@storybook/react-vite';

import { ConfirmActionButton } from './confirm-action-button';

const meta = {
  title: 'Components/ConfirmActionButton',
  component: ConfirmActionButton,
  decorators: [(story) => <div className="h-[320px]">{story()}</div>],
  args: {
    question: 'Remove this worktree?',
    description:
      'The checkout at feat/thread-analysis is deleted; its branch is kept.',
    confirmLabel: 'Remove',
    busyLabel: 'Removing…',
    onConfirm: async (): Promise<void> => undefined,
    children: 'Remove',
  },
} satisfies Meta<typeof ConfirmActionButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Failing: Story = {
  args: {
    onConfirm: () => Promise.reject(new Error('It holds unsaved work.')),
  },
};
