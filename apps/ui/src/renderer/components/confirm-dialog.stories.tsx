import type { Meta, StoryObj } from '@storybook/react-vite';

import { ConfirmDialog } from './confirm-dialog';

const meta = {
  title: 'Components/ConfirmDialog',
  component: ConfirmDialog,
  args: {
    open: true,
    title: 'Delete workflow',
    confirmLabel: 'Delete',
    busyLabel: 'Deleting…',
    onCancel: () => undefined,
    onConfirm: () => undefined,
    children:
      'This removes the workflow and every run it produced. This cannot be undone.',
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Busy: Story = {
  args: { busy: true },
};

export const WithError: Story = {
  args: { error: 'Could not delete the workflow — a run is still active.' },
};
