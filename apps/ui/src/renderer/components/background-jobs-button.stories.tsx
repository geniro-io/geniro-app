import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  BACKGROUND_JOBS,
  JOBS_NOW,
  NO_BACKGROUND_JOBS,
} from '../__fixtures__/background-jobs';
import { BackgroundJobsButton } from './background-jobs-button';

const meta = {
  title: 'Components/BackgroundJobsButton',
  component: BackgroundJobsButton,
  decorators: [
    (story) => (
      <div className="flex h-[520px] justify-end bg-sidebar p-2">{story()}</div>
    ),
  ],
  args: {
    open: true,
    onOpenChange: () => undefined,
    data: BACKGROUND_JOBS,
    error: null,
    now: JOBS_NOW,
    onOpenThread: () => undefined,
    onReview: () => undefined,
    onShowHistory: () => undefined,
  },
  render: function Render(args) {
    const [open, setOpen] = useState(args.open);
    return (
      <BackgroundJobsButton {...args} open={open} onOpenChange={setOpen} />
    );
  },
} satisfies Meta<typeof BackgroundJobsButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = {};

export const Idle: Story = {
  args: {
    data: {
      ...BACKGROUND_JOBS,
      active: [],
      running: 0,
    },
  },
};

export const NothingYet: Story = {
  args: { data: NO_BACKGROUND_JOBS },
};

export const Closed: Story = {
  args: { open: false },
};
