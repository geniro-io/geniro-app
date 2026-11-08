import type { Meta, StoryObj } from '@storybook/react-vite';

import { KnowledgeProjectSection } from './knowledge-project-section';

const meta: Meta<typeof KnowledgeProjectSection> = {
  title: 'Knowledge/KnowledgeProjectSection',
  component: KnowledgeProjectSection,
  args: { active: 3, waiting: 2, onOpen: () => {} },
};

export default meta;
type Story = StoryObj<typeof KnowledgeProjectSection>;

export const WithDocuments: Story = {};

export const Empty: Story = { args: { active: 0, waiting: 0 } };
