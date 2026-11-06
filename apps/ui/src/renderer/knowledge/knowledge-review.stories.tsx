import type { Meta, StoryObj } from '@storybook/react-vite';

import { aKnowledgeRevision } from '../__fixtures__/knowledge';
import { KnowledgeReview } from './knowledge-review';

const meta: Meta<typeof KnowledgeReview> = {
  title: 'Knowledge/KnowledgeReview',
  component: KnowledgeReview,
  args: {
    revision: aKnowledgeRevision(),
    onBack: () => {},
    onApprove: async () => {},
    onReject: async () => {},
    onOpenDocument: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof KnowledgeReview>;

export const Change: Story = {};

export const NewDocument: Story = {
  args: { revision: aKnowledgeRevision({ baseRev: 0, diff: '' }) },
};

export const Stale: Story = {
  args: { revision: aKnowledgeRevision({ stale: true }) },
};
