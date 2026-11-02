import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { aProject } from '../__fixtures__/projects';
import { ProjectSelect } from './project-select';

const PROJECTS = [
  aProject({ id: 'p-app', name: 'App', folder: '/Users/me/code/app' }),
  aProject({ id: 'p-billing', name: 'Billing', folder: '/Users/me/billing' }),
];

function Picker({
  variant,
  initial,
}: {
  variant: 'default' | 'ghost';
  initial: string | null;
}): React.JSX.Element {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <ProjectSelect
      variant={variant}
      projects={PROJECTS}
      value={value}
      noneLabel={variant === 'ghost' ? 'No project' : 'None'}
      aria-label="Project"
      onChange={setValue}
    />
  );
}

const meta = {
  title: 'Chats/ProjectSelect',
  component: Picker,
  args: { variant: 'ghost', initial: 'p-app' },
  decorators: [
    (story) => (
      <div className="h-[260px] w-[420px] bg-background p-3 text-foreground">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof Picker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The composer's chip, on the folder's own project. */
export const ComposerChip: Story = {};

/** The run-configuration editor's row, bound to no project. */
export const EditorRowNone: Story = {
  args: { variant: 'default', initial: null },
};
