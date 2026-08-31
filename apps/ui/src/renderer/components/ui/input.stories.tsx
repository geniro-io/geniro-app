import type { Meta, StoryObj } from '@storybook/react-vite';

import { Input } from './input';

const meta = {
  title: 'Primitives/Input',
  component: Input,
  args: { placeholder: 'Name this configuration…' },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithValue: Story = {
  args: { defaultValue: 'Design system storybook' },
};

export const Disabled: Story = {
  args: { defaultValue: 'Locked while the turn is running', disabled: true },
};

export const Invalid: Story = {
  args: { defaultValue: '', 'aria-invalid': true, placeholder: 'Required' },
};
