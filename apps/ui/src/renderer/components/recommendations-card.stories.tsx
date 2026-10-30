import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  HOTSPOTS,
  ITEMS,
  LOOK,
  recommendation,
  TIMING,
  WORKFLOW_STATS,
} from '../__fixtures__/recommendations';
import { RecommendationsCard } from './recommendations-card';

/** Selecting, with a working Apply that moves the card to "applying". */
function SelectingDemo(): React.JSX.Element {
  const [applied, setApplied] = useState<string[] | null>(null);
  return (
    <div className="w-[600px]">
      <RecommendationsCard
        look={LOOK}
        summary="Most of each run goes to the reviewer: the two reviews run one after the other, and QA runs its checklist on opus."
        timing={null}
        workflowStats={WORKFLOW_STATS}
        hotspots={HOTSPOTS}
        workflow
        items={ITEMS}
        applied={applied}
        outcomes={{}}
        onApply={setApplied}
      />
    </div>
  );
}

const meta = {
  title: 'Components/RecommendationsCard',
  component: SelectingDemo,
} satisfies Meta<typeof SelectingDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Selecting: Story = {};

export const Applied: Story = {
  render: () => (
    <div className="w-[560px]">
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflowStats={WORKFLOW_STATS}
        hotspots={HOTSPOTS}
        workflow
        items={ITEMS}
        applied={['W-1', 'R-1']}
        outcomes={{
          'W-1': {
            status: 'applied',
            note: null,
            backup: '.backups/dev-team.2026-10-14T21-05-33.yaml',
          },
          'R-1': {
            status: 'failed',
            note: '.claude/rules/billing.md changed since the analysis',
            backup: null,
          },
        }}
      />
    </div>
  ),
};

export const PlainChat: Story = {
  render: () => (
    <div className="w-[420px]">
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        hotspots={[
          {
            title: 'The test suite ran four times',
            node: null,
            why: 'Each fix re-ran the whole suite instead of the one failing spec: 4 × 6m of the 3h.',
            items: ['R-1'],
          },
        ]}
        workflow={false}
        items={[recommendation('R-1'), recommendation('R-2')]}
        applied={null}
        outcomes={{}}
        onApply={() => undefined}
      />
    </div>
  ),
};

export const WithMemory: Story = {
  render: () => (
    <div className="w-[420px]">
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        workflow={false}
        items={[
          recommendation('R-1'),
          recommendation('M-1', {
            territory: 'domain',
            kind: 'update',
            location: 'm12',
            title: 'Correct the stale billing-cycle note',
          }),
        ]}
        applied={null}
        outcomes={{}}
        onApply={() => undefined}
      />
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div className="w-[560px]">
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        workflow
        items={[]}
        applied={null}
        outcomes={{}}
        onApply={() => undefined}
      />
    </div>
  ),
};

export const Phone: Story = {
  render: () => (
    <div className="w-[360px]">
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflowStats={WORKFLOW_STATS}
        hotspots={HOTSPOTS}
        workflow
        items={ITEMS}
        applied={null}
        outcomes={{}}
        onApply={() => undefined}
      />
    </div>
  ),
};
