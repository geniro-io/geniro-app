import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { LOOK, WORKFLOW_STATS } from '../__fixtures__/recommendations';
import {
  RecommendationsProjection,
  WorkflowFigures,
} from './recommendations-figures';

function FiguresDemo(): React.JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<string>>(
    new Set(['figures:models']),
  );
  return (
    <div className="w-[560px]">
      <WorkflowFigures
        stats={WORKFLOW_STATS}
        look={LOOK}
        hotNodes={new Set(['reviewer'])}
        folds={{
          isOpen: (key) => open.has(key),
          toggle: (key) =>
            setOpen((current) => {
              const next = new Set(current);
              if (!next.delete(key)) {
                next.add(key);
              }
              return next;
            }),
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Components/RecommendationsFigures',
  component: FiguresDemo,
} satisfies Meta<typeof FiguresDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Figures: Story = {};

export const Projection: Story = {
  render: () => (
    <div className="w-[560px]">
      <RecommendationsProjection
        baseline={{ wallMs: 42 * 60_000, costUsd: 3.1 }}
        minutesSaved={28}
        costSavedUsd={1.25}
        scope="with the 2 selected"
        look={LOOK}
      />
    </div>
  ),
};

export const ProjectionThatCostsMore: Story = {
  render: () => (
    <div className="w-[560px]">
      <RecommendationsProjection
        baseline={{ wallMs: 42 * 60_000, costUsd: 3.1 }}
        minutesSaved={-4}
        costSavedUsd={-0.5}
        scope="with the 1 selected"
        look={LOOK}
      />
    </div>
  ),
};
