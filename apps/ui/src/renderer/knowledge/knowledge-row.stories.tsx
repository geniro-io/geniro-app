import type { Meta, StoryObj } from '@storybook/react-vite';

import { aKnowledgeHead } from '../__fixtures__/knowledge';
import { KnowledgeRow } from './knowledge-row';

const meta: Meta<typeof KnowledgeRow> = {
  title: 'Knowledge/KnowledgeRow',
  component: KnowledgeRow,
  args: {
    document: aKnowledgeHead(),
    placeName: 'Atlas',
    onOpen: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof KnowledgeRow>;

export const Active: Story = {};

export const ChangeWaiting: Story = {
  args: { document: aKnowledgeHead({ pending: 1 }) },
};

export const NewWaiting: Story = {
  args: { document: aKnowledgeHead({ status: 'proposed', rev: 0 }) },
};

export const Archived: Story = {
  args: { document: aKnowledgeHead({ status: 'archived' }) },
};

export const LongContent: Story = {
  args: {
    document: aKnowledgeHead({
      title:
        'Release checklist for the desktop app, the daemon and every package we publish from the monorepo',
      whenToRead:
        'Cutting a release, bumping a version, writing the changelog, checking that the update feed serves the new build on both chips, and rolling a bad build back when a user reports it.',
      handle: 'release-checklist-desktop-daemon-packages',
      bodyBytes: 248_000,
    }),
  },
};
