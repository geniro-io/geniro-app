import type { Meta, StoryObj } from '@storybook/react-vite';

import { ClampedText } from './clamped-text';

const LONG_TEXT = Array.from(
  { length: 6 },
  () =>
    'The Senior Engineer owns a piece of work end to end — it scopes it, builds from a spec when the user wanted one and reports a computed delivery verdict.',
).join(' ');

const meta = {
  title: 'Components/ClampedText',
  component: ClampedText,
  args: {
    text: LONG_TEXT,
    lines: 3,
    slot: 'clamped-text',
    className: 'text-sm text-muted-foreground',
  },
  decorators: [(story) => <div className="w-[480px]">{story()}</div>],
} satisfies Meta<typeof ClampedText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Clamped: Story = {};

export const TwoLines: Story = { args: { lines: 2 } };

export const Short: Story = {
  args: { text: 'Plans a change, builds it and ships a pull request.' },
};
