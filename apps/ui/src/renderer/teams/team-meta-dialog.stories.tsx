import type { Meta, StoryObj } from '@storybook/react-vite';

import { TeamMetaDialog } from './team-meta-dialog';

const meta = {
  title: 'Teams/TeamMetaDialog',
  component: TeamMetaDialog,
  args: {
    open: true,
    busy: false,
    title: 'Change team',
    submitLabel: 'Save',
    busyLabel: 'Saving…',
    maxActiveTurnsCeiling: 8,
    onClose: () => undefined,
    onSubmit: () => undefined,
  },
  decorators: [(story) => <div className="h-[640px]">{story()}</div>],
} satisfies Meta<typeof TeamMetaDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Edit: Story = {
  args: {
    initial: {
      name: 'Review team',
      description: 'Codes then reviews.',
      maxActiveTurns: 3,
    },
  },
};

export const New: Story = {
  args: {
    title: 'New team',
    submitLabel: 'Create',
    busyLabel: 'Creating…',
  },
};
