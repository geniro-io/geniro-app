import type { Meta, StoryObj } from '@storybook/react-vite';

import { memoryEntry } from '../__fixtures__/memories';
import { PUBLISHED_IDENTITIES } from '../__tests__/agent-identities';
import { AgentIdentityContext } from '../agent-identity';
import { ProvenanceLine } from './provenance-line';

const meta = {
  title: 'Components/ProvenanceLine',
  component: ProvenanceLine,
  args: { entry: memoryEntry(), projectName: null },
  decorators: [
    (story) => (
      <AgentIdentityContext.Provider value={PUBLISHED_IDENTITIES}>
        {story()}
      </AgentIdentityContext.Provider>
    ),
  ],
} satisfies Meta<typeof ProvenanceLine>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WrittenByYou: Story = {};

export const SavedByAnAgent: Story = {
  args: {
    entry: memoryEntry({
      projectId: 'project-billing',
      source: {
        actor: 'agent',
        agentKind: 'claude',
        model: 'opus',
        runId: 'run-1',
        importedFrom: null,
      },
    }),
    projectName: 'Billing',
  },
};

export const SavedByAnAnalysis: Story = {
  args: {
    entry: memoryEntry({
      source: {
        actor: 'analysis',
        agentKind: 'codex',
        model: null,
        runId: 'run-1',
        importedFrom: null,
      },
    }),
  },
};

export const ImportedAndApproved: Story = {
  args: {
    entry: memoryEntry({
      approvedAt: '2026-10-21T09:00:00.000Z',
      source: {
        actor: 'import',
        agentKind: 'cursor-agent',
        model: null,
        runId: null,
        importedFrom: '/Users/me/.cursor/projects/website/memory/deploys.md',
      },
    }),
  },
};

export const RemovedProject: Story = {
  args: { entry: memoryEntry({ projectId: 'gone' }), projectName: null },
};
