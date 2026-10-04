import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  ProcessFigureCells,
  ProcessFigureHeader,
  ShareBar,
} from './process-figures';

const meta = {
  title: 'Components/ProcessFigures',
  component: ProcessFigureCells,
  args: { cpuPercent: 12.4, rssBytes: 312 * 1024 * 1024 },
  decorators: [
    (story) => <div className="w-72 bg-background p-3">{story()}</div>,
  ],
} satisfies Meta<typeof ProcessFigureCells>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => (
    <div className="flex flex-col gap-1 text-xs">
      <ProcessFigureHeader label="process" />
      <div className="flex items-baseline gap-1.5">
        <span className="flex-1">claude</span>
        <ProcessFigureCells {...args} />
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="flex-1">idle MCP server</span>
        <ProcessFigureCells cpuPercent={0} rssBytes={44 * 1024 * 1024} />
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="flex-1">busy build</span>
        <ProcessFigureCells cpuPercent={187.5} rssBytes={1.4 * 1024 ** 3} />
      </div>
    </div>
  ),
};

export const Share: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <ShareBar fraction={0.72} label="72% of memory" />
      <ShareBar fraction={0.2} label="20% of memory" />
      <ShareBar fraction={0.004} label="under 1% of memory" />
    </div>
  ),
};
