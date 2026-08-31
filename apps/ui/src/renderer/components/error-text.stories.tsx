import type { Meta, StoryObj } from '@storybook/react-vite';

import { ErrorText } from './error-text';

const meta = {
  title: 'Components/ErrorText',
  component: ErrorText,
  args: { children: 'This field is required.' },
} satisfies Meta<typeof ErrorText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const LongMessage: Story = {
  decorators: [(story) => <div className="w-64">{story()}</div>],
  args: {
    children:
      'The custom instructions field contains invisible control characters and was not saved — remove them and try again.',
  },
};
