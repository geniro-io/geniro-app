import type { Meta, StoryObj } from '@storybook/react-vite';

import { ErrorBanner } from './error-banner';
import { Button } from './ui/button';

const meta = {
  title: 'Components/ErrorBanner',
  component: ErrorBanner,
  args: {
    message: 'Could not load the workflow.',
    onDismiss: () => undefined,
  },
  decorators: [(story) => <div className="w-[420px]">{story()}</div>],
} satisfies Meta<typeof ErrorBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Warning: Story = {
  args: {
    tone: 'warning',
    message:
      'This branch has uncommitted changes — switch anyway, or pull first.',
  },
};

export const WithAction: Story = {
  args: {
    message: 'This directory is already used by another worktree.',
    action: (
      <Button type="button" variant="outline" size="sm">
        Use that worktree
      </Button>
    ),
  },
};

export const LongMessage: Story = {
  args: {
    message:
      'daemon POST /v1/chats/run-42/messages failed (409): RUN_ARCHIVED — this chat has been archived and no longer accepts new messages until it is restored',
  },
};
