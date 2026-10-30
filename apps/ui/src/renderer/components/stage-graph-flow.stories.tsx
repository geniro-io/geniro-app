import type { Meta, StoryObj } from '@storybook/react-vite';

import type { StageGraphStage } from './stage-graph';
import StageGraphFlow from './stage-graph-flow';

const TEAM: StageGraphStage[] = [
  { id: 'triage', title: 'Triage and run plan', next: ['plan', 'answer'] },
  { id: 'plan', title: 'Planning', next: ['build'] },
  { id: 'build', title: 'Build or change', next: ['review'] },
  {
    id: 'answer',
    title: 'Answer, findings or small job',
    next: ['build', 'close-out'],
  },
  { id: 'review', title: 'Agent review', next: ['verification'] },
  { id: 'verification', title: 'Verification on the stand', next: ['ship'] },
  { id: 'ship', title: 'PR visuals', next: ['close-out'] },
  { id: 'close-out', title: 'Handoff and close-out' },
];

const meta = {
  title: 'Components/StageGraphFlow',
  component: StageGraphFlow<StageGraphStage>,
  args: { stages: TEAM },
  decorators: [
    (story) => (
      <div className="rounded-xl border border-border bg-background p-3">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof StageGraphFlow<StageGraphStage>>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A branch that skips most stages is routed beside them, never across a pill. */
export const SkipAndFork: Story = {};

export const SkipAndForkInARun: Story = {
  args: {
    stages: TEAM.map((stage) => ({
      ...stage,
      status:
        stage.id === 'triage'
          ? 'done'
          : stage.id === 'answer'
            ? 'current'
            : stage.id === 'plan'
              ? 'not_taken'
              : 'pending',
    })),
  },
};

export const LoopBack: Story = {
  args: {
    stages: [
      { id: 'a', title: 'Draft', next: ['b'] },
      { id: 'b', title: 'Review', next: ['c', 'd'] },
      { id: 'c', title: 'Revise', next: ['b'] },
      { id: 'd', title: 'Ship' },
    ],
  },
};

export const NarrowRoom: Story = {
  args: { fitWidth: 520 },
};
