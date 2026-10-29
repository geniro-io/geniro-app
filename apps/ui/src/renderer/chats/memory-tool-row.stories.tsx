import type { Meta, StoryObj } from '@storybook/react-vite';

import { MemoryOpenContext, MemoryToolRow } from './memory-tool-row';

const meta = {
  title: 'Chats/MemoryToolRow',
  component: MemoryToolRow,
  args: { status: 'done' },
  decorators: [
    (story) => <div className="w-[560px] bg-background p-4">{story()}</div>,
  ],
} satisfies Meta<typeof MemoryToolRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Searched: Story = {
  args: {
    entry: { tool: 'memory_search', query: 'database migrations', count: 3 },
  },
};

export const Searching: Story = {
  args: {
    status: 'running',
    entry: { tool: 'memory_search', query: 'database migrations', count: null },
  },
};

export const Read: Story = {
  args: {
    entry: { tool: 'memory_read', handles: ['m3', 'm5'], missing: [] },
  },
};

export const ReadWithAMissingHandle: Story = {
  args: {
    entry: { tool: 'memory_read', handles: ['m3', 'm4'], missing: ['m4'] },
  },
};

export const Saved: Story = {
  args: {
    entry: {
      tool: 'memory_save',
      title: 'Schema sync is additive; never hand-write migrations',
      handle: 'm12',
      outcome: 'saved',
      pending: false,
      note: null,
    },
  },
};

export const SavedPendingReview: Story = {
  args: {
    entry: {
      tool: 'memory_save',
      title: 'Schema sync is additive; never hand-write migrations',
      handle: 'm12',
      outcome: 'saved',
      pending: true,
      note: null,
    },
  },
};

export const Updated: Story = {
  args: {
    entry: {
      tool: 'memory_save',
      title: 'Schema sync is additive; never hand-write migrations',
      handle: 'm12',
      outcome: 'updated',
      pending: false,
      note: null,
    },
  },
};

export const NearDuplicate: Story = {
  args: {
    status: 'error',
    entry: {
      tool: 'memory_save',
      title: 'Use pnpm',
      handle: null,
      outcome: 'duplicate',
      pending: false,
      note: null,
    },
  },
};

export const Refused: Story = {
  args: {
    status: 'error',
    entry: {
      tool: 'memory_save',
      title: 'Deploy key',
      handle: null,
      outcome: 'refused',
      pending: false,
      note: 'the body looks like it holds a credential.',
    },
  },
};

export const Forgot: Story = {
  args: {
    entry: {
      tool: 'memory_forget',
      handle: 'm12',
      reason: 'superseded by the monorepo move',
      failure: null,
    },
  },
};

export const HandlesOpenSettingsMemory: Story = {
  args: {
    entry: { tool: 'memory_read', handles: ['m3', 'm5'], missing: [] },
  },
  decorators: [
    (story) => (
      <MemoryOpenContext.Provider value={() => {}}>
        {story()}
      </MemoryOpenContext.Provider>
    ),
  ],
};
