import type { Meta, StoryObj } from '@storybook/react-vite';

import { ReadOnlyText } from './read-only-text';

const LONG_TEXT = Array.from(
  { length: 8 },
  (_, index) =>
    `Rule ${index + 1}: work in a worktree on a new branch cut from main, set its env up as the project instructions say, and never run a migration against a database the main checkout shares.`,
).join('\n');

const meta = {
  title: 'Components/ReadOnlyText',
  component: ReadOnlyText,
  args: { title: 'Team Settings', text: LONG_TEXT },
  decorators: [(story) => <div className="w-[480px]">{story()}</div>],
} satisfies Meta<typeof ReadOnlyText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Long: Story = {};

export const TwoLines: Story = { args: { lines: 2 } };

export const Short: Story = {
  args: { text: 'Plans a change, builds it and ships a pull request.' },
};

export const Empty: Story = { args: { text: '' } };
