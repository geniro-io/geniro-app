import type { Meta, StoryObj } from '@storybook/react-vite';

import { backgroundJob, JOBS_NOW } from '../__fixtures__/background-jobs';
import { BackgroundJobRow } from './background-job-row';

const meta = {
  title: 'Components/BackgroundJobRow',
  component: BackgroundJobRow,
  decorators: [(story) => <div className="w-[22rem]">{story()}</div>],
  args: {
    job: backgroundJob(),
    now: JOBS_NOW,
    onOpenThread: () => undefined,
    onReview: () => undefined,
  },
} satisfies Meta<typeof BackgroundJobRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FiledLessons: Story = {};

export const Running: Story = {
  args: {
    job: backgroundJob({
      status: 'running',
      phase: 'checking',
      endedAt: null,
      lessons: null,
    }),
  },
};

export const Queued: Story = {
  args: {
    job: backgroundJob({
      status: 'queued',
      endedAt: null,
      costUsd: null,
      durationMs: null,
      lessons: null,
    }),
  },
};

export const NoLessonsFound: Story = {
  args: {
    job: backgroundJob({ lessons: { saved: 0, waiting: 0, dropped: 0 } }),
  },
};

export const Failed: Story = {
  args: {
    job: backgroundJob({
      status: 'failed',
      costUsd: null,
      durationMs: null,
      error: "You've hit your weekly limit · resets 4pm",
      lessons: null,
    }),
  },
};
