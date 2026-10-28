import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { StageGraph, type StageGraphStage } from './stage-graph';

const FORK: StageGraphStage[] = [
  {
    id: 'investigation',
    title: 'Investigation',
    next: ['implementation', 'fix'],
  },
  { id: 'implementation', title: 'Implementation', next: ['review'] },
  { id: 'fix', title: 'Fix', next: ['review'] },
  { id: 'review', title: 'Review' },
];

const meta = {
  title: 'Components/StageGraph',
  component: StageGraph<StageGraphStage>,
  args: { stages: FORK },
  decorators: [
    (story) => (
      <div className="max-w-md rounded-xl border border-border bg-background p-3">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof StageGraph<StageGraphStage>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fork: Story = {};

export const Line: Story = {
  args: {
    stages: [
      { id: 'plan', title: 'Plan', next: ['build'] },
      { id: 'build', title: 'Build', next: ['review'] },
      { id: 'review', title: 'Review', next: ['ship'] },
      { id: 'ship', title: 'Ship' },
    ],
  },
};

export const RunInProgress: Story = {
  args: {
    stages: [
      { ...FORK[0]!, status: 'done' },
      { ...FORK[1]!, status: 'not_taken' },
      { ...FORK[2]!, status: 'current' },
      { ...FORK[3]!, status: 'pending' },
    ],
  },
};

export const RunFinished: Story = {
  args: {
    stages: [
      { ...FORK[0]!, status: 'done' },
      { ...FORK[1]!, status: 'not_taken' },
      { ...FORK[2]!, status: 'skipped' },
      { ...FORK[3]!, status: 'done' },
    ],
  },
};

export const Interactive: Story = {
  render: (args) => {
    const [selected, setSelected] = useState<string | null>('investigation');
    return (
      <StageGraph
        {...args}
        selectedId={selected}
        errorIds={new Set(['fix'])}
        onSelect={setSelected}
      />
    );
  },
};

export const Loop: Story = {
  args: {
    stages: [
      { id: 'a', title: 'Draft', next: ['b'] },
      { id: 'b', title: 'Review', next: ['c'] },
      { id: 'c', title: 'Revise', next: ['b'] },
    ],
    errorIds: new Set(['b']),
  },
};

export const Narrow: Story = {
  decorators: [
    (story) => (
      <div className="w-64 rounded-md border border-dashed border-border-strong">
        {story()}
      </div>
    ),
  ],
  args: {
    stages: [
      { id: 'a', title: 'Investigate the failing build', next: ['b', 'c'] },
      { id: 'b', title: 'Implementation', next: ['d'] },
      { id: 'c', title: 'Quick fix', next: ['d'] },
      { id: 'd', title: 'Code review', next: ['e'] },
      { id: 'e', title: 'Release notes', next: ['f'] },
      { id: 'f', title: 'Ship' },
    ],
  },
};

export const AgentsPanelWidth: Story = {
  decorators: [
    (story) => (
      <div className="w-[280px] rounded-md border border-dashed border-border-strong">
        {story()}
      </div>
    ),
  ],
  args: {
    stages: [
      { ...FORK[0]!, status: 'done' },
      { ...FORK[1]!, status: 'current' },
      { ...FORK[2]!, status: 'not_taken' },
      { ...FORK[3]!, status: 'pending' },
    ],
  },
};

/** Told how much room it has (`fitWidth`) instead of measuring its container: the pills narrow to fit. */
export const FitWidth: Story = {
  args: { fitWidth: 300 },
};
