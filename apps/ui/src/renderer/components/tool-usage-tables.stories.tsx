import type { Meta, StoryObj } from '@storybook/react-vite';

import { ToolUsageTables } from './tool-usage-tables';

const meta = {
  title: 'Components/ToolUsageTables',
  component: ToolUsageTables,
  args: {
    emptyLabel: 'No tool calls recorded in this period.',
    tools: [
      { tool: 'Bash', mcpServer: null, calls: 412, errors: 9, avgMs: 1_240 },
      { tool: 'Read', mcpServer: null, calls: 380, errors: 0, avgMs: 40 },
      {
        tool: 'codegraph_explore',
        mcpServer: 'codegraph',
        calls: 51,
        errors: 2,
        avgMs: 2_800,
      },
      {
        tool: 'show_chart',
        mcpServer: 'geniro',
        calls: 4,
        errors: 0,
        avgMs: null,
      },
    ],
    mcpServers: [
      { server: 'codegraph', calls: 51, errors: 2, tools: 1 },
      { server: 'geniro', calls: 4, errors: 0, tools: 1 },
    ],
  },
} satisfies Meta<typeof ToolUsageTables>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Empty: Story = { args: { tools: [], mcpServers: [] } };
