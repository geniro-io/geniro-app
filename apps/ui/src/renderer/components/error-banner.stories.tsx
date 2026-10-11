import type { Meta, StoryObj } from '@storybook/react-vite';
import { TriangleAlert } from 'lucide-react';

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

/** A notice whose text keeps moving: an icon says what kind it is, and it is
 * announced politely rather than as an alert. */
export const WarningWithIcon: Story = {
  args: {
    tone: 'warning',
    icon: <TriangleAlert />,
    announce: 'status',
    size: 'sm',
    message:
      'Prompt cache expired 3m ago — the next message re-caches ~794k tokens at full price. On extra usage the cache lasts only 5 minutes.',
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
