import type { Meta, StoryObj } from '@storybook/react-vite';

import { BACKGROUND_JOBS, JOBS_NOW } from '../__fixtures__/background-jobs';
import { BackgroundJobsHistoryDialog } from './background-jobs-history-dialog';

const meta = {
  title: 'Components/BackgroundJobsHistoryDialog',
  component: BackgroundJobsHistoryDialog,
  decorators: [(story) => <div className="h-[560px]">{story()}</div>],
  args: {
    open: true,
    onClose: () => undefined,
    jobs: [...BACKGROUND_JOBS.active, ...BACKGROUND_JOBS.finished],
    hasMore: true,
    loading: false,
    error: null,
    now: JOBS_NOW,
    onLoadMore: () => undefined,
    onOpenThread: () => undefined,
    onReview: () => undefined,
  },
} satisfies Meta<typeof BackgroundJobsHistoryDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllRuns: Story = {};

export const LastPage: Story = {
  args: { hasMore: false },
};

export const Empty: Story = {
  args: { jobs: [], hasMore: false },
};
