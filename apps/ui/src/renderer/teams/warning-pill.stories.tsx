import type { Meta, StoryObj } from '@storybook/react-vite';

import { WarningPill } from './warning-pill';

const meta = {
  title: 'Teams/WarningPill',
  component: WarningPill,
  args: {
    onGoToMember: () => {},
    problems: [
      {
        key: 'ada-mcp',
        member: { id: 'ada', name: 'Ada' },
        message: 'MCP github needs sign-in',
        level: 'warning',
        fix: { label: 'Fix', run: () => {} },
      },
      {
        key: 'linus-cli',
        member: { id: 'linus', name: 'Linus' },
        message: 'codex is not installed on this Mac',
        level: 'error',
        fix: { label: 'Open Settings', run: () => {} },
      },
    ],
  },
  decorators: [(story) => <div className="h-[260px]">{story()}</div>],
} satisfies Meta<typeof WarningPill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Blocking: Story = {};

export const Informing: Story = {
  args: {
    problems: [
      {
        key: 'grace-role',
        member: { id: 'grace', name: 'Grace' },
        message: 'Has no role — the others will not know what to ask her',
        level: 'warning',
      },
    ],
  },
};

export const Nothing: Story = { args: { problems: [] } };
