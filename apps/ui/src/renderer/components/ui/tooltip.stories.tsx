import type { Meta, StoryObj } from '@storybook/react-vite';
import { NotebookPen, Search, SquareTerminal } from 'lucide-react';

import { Button } from './button';
import { TooltipLayer } from './tooltip';

const meta = {
  title: 'Primitives/Tooltip',
  component: TooltipLayer,
} satisfies Meta<typeof TooltipLayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <div className="flex items-center gap-1 p-8">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Search this conversation"
        title="Search this conversation">
        <Search />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open a terminal"
        title={
          'Open a terminal in this thread’s folder\n~/Projects/geniro-app'
        }>
        <SquareTerminal />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Add thread notes"
        title="Add thread notes">
        <NotebookPen />
      </Button>
      <TooltipLayer />
    </div>
  ),
};
