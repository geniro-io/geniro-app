import type { Meta, StoryObj } from '@storybook/react-vite';

import { NO_PROJECT_NAME, ProjectBlock } from './project-block';

const meta = {
  title: 'Command center/ProjectBlock',
  component: ProjectBlock,
  args: { name: 'Geniro', color: 'blue', threads: 3, working: 2 },
  decorators: [(story) => <div className="h-[260px] w-[680px]">{story()}</div>],
} satisfies Meta<typeof ProjectBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = {};

/** A project none of whose threads works now. */
export const Quiet: Story = {
  args: { name: 'PriceField', color: 'orange', threads: 1, working: 0 },
};

/** Threads that belong to no project. */
export const NoProject: Story = {
  args: { name: NO_PROJECT_NAME, color: null, threads: 2, working: 0 },
};
