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

/**
 * The RESTING look is the only thing `variant` sets — press once and the button
 * paints itself destructive whatever it started as. This story was
 * `DestructiveVariant`, which is exactly the misuse the prop now excludes: it
 * documented starting the control in its own end state, so arming changed
 * nothing but the label. Press it to see the difference this story exists for.
 */
export const GhostVariant: Story = {
  args: { variant: 'ghost', children: 'End session' },
};
