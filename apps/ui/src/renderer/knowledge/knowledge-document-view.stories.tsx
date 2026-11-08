import type { Meta, StoryObj } from '@storybook/react-vite';

import { aKnowledgeDocument } from '../__fixtures__/knowledge';
import { KnowledgeDocumentView } from './knowledge-document-view';

const meta: Meta<typeof KnowledgeDocumentView> = {
  title: 'Knowledge/KnowledgeDocumentView',
  component: KnowledgeDocumentView,
  args: {
    document: aKnowledgeDocument(),
    placeName: 'Atlas',
    canExport: true,
    onBack: () => {},
    onEdit: () => {},
    onHistory: () => {},
    onExport: () => {},
    onArchive: () => {},
    onRestore: () => {},
    onDelete: async () => {},
    onReview: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof KnowledgeDocumentView>;

export const Read: Story = {};

export const ChangeWaiting: Story = {
  args: { document: aKnowledgeDocument({ pending: 1 }) },
};

export const Archived: Story = {
  args: { document: aKnowledgeDocument({ status: 'archived' }) },
};
