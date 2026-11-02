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
        members: [{ id: 'ada', name: 'Ada' }],
        message: 'MCP github needs sign-in',
        level: 'warning',
        fix: { label: 'Fix', run: () => {} },
      },
      {
        key: 'linus-cli',
        members: [{ id: 'linus', name: 'Linus' }],
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
        members: [{ id: 'grace', name: 'Grace' }],
        message: 'Has no role — the others will not know what to ask her',
        level: 'warning',
      },
    ],
  },
};

export const SharedAccount: Story = {
  args: {
    problems: [
      {
        key: 'servers',
        members: [
          { id: 'manager', name: 'Manager' },
          { id: 'senior', name: 'Senior Engineer' },
          { id: 'middle', name: 'Middle Engineer' },
          { id: 'researcher', name: 'Researcher' },
          { id: 'qa', name: 'QA' },
        ],
        message: '24 MCP servers need signing in.',
        level: 'warning',
        account: 'Claude Code · default profile',
        details: [
          'claude.ai Rebrandly',
          'claude.ai Document360',
          'claude.ai Zoom for Claude',
          'claude.ai Luma',
          'claude.ai Miro',
          'claude.ai Asana',
        ],
        fix: { label: 'Open MCP', run: () => {} },
      },
    ],
  },
};

export const Nothing: Story = { args: { problems: [] } };
