import type { Meta, StoryObj } from '@storybook/react-vite';

import { ArchiveThreadButton, ArchiveThreadIcon } from './thread-archive';

function ThreadArchiveControls(): React.JSX.Element {
  return (
    <div className="flex items-center gap-4">
      <ArchiveThreadIcon
        title="Fix the login redirect"
        onArchive={() => undefined}
      />
      <ArchiveThreadButton
        slot="story-archive"
        title="Fix the login redirect"
        onArchive={() => undefined}
      />
    </div>
  );
}

const meta = {
  title: 'Components/ThreadArchive',
  component: ThreadArchiveControls,
} satisfies Meta<typeof ThreadArchiveControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Controls: Story = {};
