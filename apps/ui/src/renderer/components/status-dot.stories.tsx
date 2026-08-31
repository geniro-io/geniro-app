import type { Meta, StoryObj } from '@storybook/react-vite';

import { StatusDot } from './status-dot';

const meta = {
  title: 'Components/StatusDot',
  component: StatusDot,
  args: { tone: 'ok' },
  argTypes: {
    tone: { control: 'select', options: ['ok', 'warn', 'bad', 'unknown'] },
  },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const AllTones: Story = {
  render: () => (
    <div className="flex items-center gap-4 text-sm text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <StatusDot tone="ok" /> ok
      </span>
      <span className="flex items-center gap-1.5">
        <StatusDot tone="warn" /> warn
      </span>
      <span className="flex items-center gap-1.5">
        <StatusDot tone="bad" /> bad
      </span>
      <span className="flex items-center gap-1.5">
        <StatusDot tone="unknown" /> unknown
      </span>
    </div>
  ),
};
