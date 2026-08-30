import type { Meta, StoryObj } from '@storybook/react-vite';

import { ConfirmButton } from './confirm-button';

const meta = {
  title: 'Components/ConfirmButton',
  component: ConfirmButton,
  args: {
    children: 'Delete workflow',
    onConfirm: () => undefined,
  },
} satisfies Meta<typeof ConfirmButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const CustomConfirmLabel: Story = {
  args: { confirmLabel: 'Really delete?' },
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const DestructiveVariant: Story = {
  args: { variant: 'destructive', children: 'End session' },
};
