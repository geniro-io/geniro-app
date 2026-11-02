import type { Meta, StoryObj } from '@storybook/react-vite';

import { memoryEntry } from '../__fixtures__/memories';
import { PUBLISHED_IDENTITIES } from '../__tests__/agent-identities';
import { AgentIdentityContext } from '../agent-identity';
import type { DaemonApis } from '../daemon-api';
import { TeamMemoryPanel } from './team-memory-panel';
import type { TeamMemories } from './use-team-memories';

const NOTES = [
  memoryEntry({
    id: 'm-1',
    handle: 'm1',
    title: 'The first reviewer never approves their own change',
    body: 'Hand the change to the second reviewer before it is merged.',
    teamSlug: 'review-crew',
  }),
  memoryEntry({
    id: 'm-2',
    handle: 'm2',
    title: 'Hand off with a brief',
    body: 'Each hand-off names the files touched and the open question.',
    teamSlug: 'review-crew',
    status: 'pending',
    source: {
      actor: 'agent',
      agentKind: 'claude',
      model: 'opus',
      runId: 'run-1',
      importedFrom: null,
    },
  }),
];

const LOADED: TeamMemories = {
  entries: NOTES,
  more: false,
  loading: false,
  error: null,
  reload: () => undefined,
};

const meta = {
  title: 'Teams/TeamMemoryPanel',
  component: TeamMemoryPanel,
  args: {
    apis: null as DaemonApis | null,
    slug: 'review-crew',
    teamName: 'Review crew',
    memories: LOADED,
  },
  decorators: [
    (story) => (
      <AgentIdentityContext.Provider value={PUBLISHED_IDENTITIES}>
        <div className="w-[640px] p-4">{story()}</div>
      </AgentIdentityContext.Provider>
    ),
  ],
} satisfies Meta<typeof TeamMemoryPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithEntries: Story = {};

export const Loading: Story = {
  args: { memories: { ...LOADED, entries: null, loading: true } },
};

export const Empty: Story = {
  args: { memories: { ...LOADED, entries: [] } },
};

export const ReadFailed: Story = {
  args: {
    memories: {
      ...LOADED,
      entries: null,
      error: 'daemon GET /v1/memories failed (500): internal error',
    },
  },
};

export const MoreThanAPage: Story = {
  args: { memories: { ...LOADED, more: true } },
};
