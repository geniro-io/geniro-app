import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  HOTSPOTS,
  ITEMS,
  LOOK,
  MEMBERS,
  recommendation,
  TEAM_STATS,
  TIMING,
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
        teamStats={TEAM_STATS}
        hotspots={HOTSPOTS}
        members={MEMBERS}
        team
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
        teamStats={TEAM_STATS}
        hotspots={HOTSPOTS}
        team
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
        team={false}
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
        team={false}
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

export const WithProject: Story = {
  render: () => (
    <div className="w-[420px]">
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        team={false}
        items={[
          recommendation('R-1'),
          recommendation('M-1'),
          recommendation('P-1'),
        ]}
        applied={null}
        outcomes={{}}
        onApply={() => undefined}
      />
    </div>
  ),
};

export const WithKnowledgeMove: Story = {
  render: () => (
    <div className="w-[420px]">
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        team={false}
        items={[
          {
            ...recommendation('P-1'),
            title: 'Take the release steps out of the instructions',
          },
          {
            ...recommendation('K-1'),
            target: 'knowledge',
            kind: 'add',
            title: 'Keep the release steps as a document',
            document: {
              place: 'project:p1',
              handle: null,
              title: 'Release checklist',
            },
            movesWith: 'P-1',
          },
        ]}
        applied={null}
        outcomes={{}}
        onApply={() => undefined}
      />
    </div>
  ),
};

export const WithOverlay: Story = {
  render: () => (
    <div className="w-[420px]">
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        team
        items={[
          recommendation('W-1'),
          recommendation('P-1'),
          recommendation('O-1', {
            target: 'overlay',
            kind: 'member',
            location: 'p-billing',
            title: 'Run the billing project’s reviewer on a stronger model',
            change: 'members:\n  - id: reviewer\n    model: opus',
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
        team
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
        teamStats={TEAM_STATS}
        hotspots={HOTSPOTS}
        team
        items={ITEMS}
        applied={null}
        outcomes={{}}
        onApply={() => undefined}
      />
    </div>
  ),
};
