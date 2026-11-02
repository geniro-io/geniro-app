import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import type { RunConfig } from '../../shared/contracts';
import { aProject } from '../__fixtures__/projects';
import { UnboundRunConfigs } from './unbound-run-configs';

const PROJECTS = [
  aProject({
    id: 'p-billing',
    name: 'Billing',
    folder: '/Users/me/code/billing',
  }),
  aProject({ id: 'p-site', name: 'Website', folder: '/Users/me/code/site' }),
];

const LOOSE: RunConfig[] = [
  {
    id: 'cfg-scratch',
    name: 'Scratch with opus',
    cwd: '/Users/me/scratch',
    branch: null,
    target: 'claude',
    model: 'opus',
    effort: null,
    contextWindow: null,
    modelParameters: {},
    approval: null,
    configDir: null,
  },
  {
    id: 'cfg-old',
    name: 'Old project, deleted',
    cwd: '/Users/me/code/legacy',
    branch: 'main',
    target: 'cursor-agent',
    model: null,
    effort: null,
    contextWindow: null,
    modelParameters: {},
    approval: null,
    configDir: null,
    projectId: 'p-deleted',
  },
];

function Unbound({ initial }: { initial: RunConfig[] }): React.JSX.Element {
  const [configs, setConfigs] = useState(initial);
  return (
    <UnboundRunConfigs
      configs={configs}
      projects={PROJECTS}
      onMove={(configId, projectId) =>
        setConfigs((current) =>
          current.map((config) =>
            config.id === configId ? { ...config, projectId } : config,
          ),
        )
      }
      onDelete={(configId) =>
        setConfigs((current) =>
          current.filter((config) => config.id !== configId),
        )
      }
    />
  );
}

const meta = {
  title: 'Projects/UnboundRunConfigs',
  component: Unbound,
  args: { initial: LOOSE },
  decorators: [
    (story) => (
      <div className="w-[720px] bg-background p-3 text-foreground">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof Unbound>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingForAProject: Story = {};
