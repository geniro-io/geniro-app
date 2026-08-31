import type { Meta, StoryObj } from '@storybook/react-vite';

import { Textarea } from './textarea';

const meta = {
  title: 'Primitives/Textarea',
  component: Textarea,
  args: { placeholder: 'Describe what this fast action should say…' },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithValue: Story = {
  args: {
    defaultValue:
      'Review the diff and report findings — file by file, most severe first.',
  },
};

export const Disabled: Story = {
  args: { defaultValue: 'This chat is archived.', disabled: true },
};

export const Invalid: Story = {
  args: { defaultValue: '', 'aria-invalid': true },
};
