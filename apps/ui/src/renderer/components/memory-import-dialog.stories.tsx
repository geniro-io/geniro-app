import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  MEMORY_IMPORT_PREVIEW,
  MEMORY_PROJECTS,
} from '../__fixtures__/memories';
import { PUBLISHED_IDENTITIES } from '../__tests__/agent-identities';
import { AgentIdentityContext } from '../agent-identity';
import { MemoryImportDialog } from './memory-import-dialog';

const meta = {
  title: 'Components/MemoryImportDialog',
  component: MemoryImportDialog,
  decorators: [
    (story) => (
      <AgentIdentityContext.Provider value={PUBLISHED_IDENTITIES}>
        <div className="h-[640px]">{story()}</div>
      </AgentIdentityContext.Provider>
    ),
  ],
  args: {
    open: true,
    onOpenChange: () => undefined,
    preview: MEMORY_IMPORT_PREVIEW,
    loading: false,
    error: null,
    importing: false,
    projects: MEMORY_PROJECTS,
    onImport: () => undefined,
  },
  render: (args) => {
    const [open, setOpen] = useState(true);
    return <MemoryImportDialog {...args} open={open} onOpenChange={setOpen} />;
  },
} satisfies Meta<typeof MemoryImportDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Preview: Story = {};

export const Loading: Story = { args: { preview: null, loading: true } };

export const NothingFound: Story = {
  args: {
    preview: { rows: [], sources: MEMORY_IMPORT_PREVIEW.sources },
  },
};

export const Importing: Story = { args: { importing: true } };

export const Failed: Story = {
  args: { preview: null, error: 'Could not read the agents’ memory folders' },
};
