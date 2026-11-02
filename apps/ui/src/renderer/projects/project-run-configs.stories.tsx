import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import type { RunConfig } from '../../shared/contracts';
import { aProject } from '../__fixtures__/projects';
import { ProjectRunConfigs } from './project-run-configs';
import type { RunConfigSources } from './use-run-config-sources';

const BILLING = aProject({
  id: 'p-billing',
  name: 'Billing',
  folder: '/Users/me/code/billing',
});

const LINKED: RunConfig[] = [
  {
    id: 'cfg-review',
    name: 'Review on main',
    cwd: '/Users/me/code/billing',
    branch: 'main',
    target: 'claude',
    model: 'opus',
    effort: null,
    contextWindow: null,
    modelParameters: {},
    approval: null,
    configDir: null,
    projectId: 'p-billing',
  },
  {
    id: 'cfg-team',
    name: 'Ship with the team',
    cwd: '/Users/me/code/billing-admin',
    branch: null,
    target: 'team:ship-it',
    model: null,
    effort: null,
    contextWindow: null,
    modelParameters: {},
    approval: null,
    configDir: null,
    projectId: 'p-billing',
  },
];

function Linked({ initial }: { initial: RunConfig[] }): React.JSX.Element {
  const [runConfigs, setRunConfigs] = useState<readonly RunConfig[]>(initial);
  const sources: RunConfigSources = {
    runConfigs,
    writeRunConfigs: async (edit) => setRunConfigs(edit),
    teams: [],
    cliDetections: null,
    recentFolders: [],
    recentConfigDirs: {},
    configProfiles: [],
    recentConfigDirsFor: () => [],
    configProfilesFor: () => [],
    approvalCapabilityFor: () => undefined,
    configDirReasonFor: () => null,
  };
  return (
    <ProjectRunConfigs
      project={BILLING}
      projects={[BILLING]}
      agentsApi={null}
      sources={sources}
      onSaved={() => {}}
      onError={() => {}}
    />
  );
}

const meta = {
  title: 'Projects/ProjectRunConfigs',
  component: Linked,
  args: { initial: LINKED },
  decorators: [
    (story) => (
      <div className="w-[640px] bg-background p-3 text-foreground">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof Linked>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two configurations bound to the project; Unlink keeps them, bound to none. */
export const TwoLinked: Story = {};

/** None bound yet. */
export const NoneLinked: Story = { args: { initial: [] } };
