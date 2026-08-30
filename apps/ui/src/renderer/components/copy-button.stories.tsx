import type { Meta, StoryObj } from '@storybook/react-vite';

import { CopyButton } from './copy-button';

const meta = {
  title: 'Components/CopyButton',
  component: CopyButton,
  args: {
    text: 'https://claude.ai/oauth/authorize?code=abc123',
  },
} satisfies Meta<typeof CopyButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const CustomLabel: Story = {
  args: { label: 'Copy sign-in link' },
};
