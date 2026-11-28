import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  approvalRequest,
  questionRequest,
} from '../__fixtures__/open-requests';
import { RequestCard } from './request-card';

const meta = {
  title: 'Command center/RequestCard',
  component: RequestCard,
  args: {
    request: questionRequest('long-worker', 'q-1'),
    onAnswer: () => undefined,
  },
  decorators: [
    (story) => <div className="w-[520px] bg-background p-4">{story()}</div>,
  ],
} satisfies Meta<typeof RequestCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A thread's question, answered in place. */
export const Question: Story = {};

/** A held tool call, approved or denied in place. */
export const Approval: Story = {
  args: { request: approvalRequest('plain-chat', 'a-1') },
};
