import type { Meta, StoryObj } from '@storybook/react-vite';

import { DiffFigures } from './diff-figures';

const meta = {
  title: 'Components/DiffFigures',
  component: DiffFigures,
} satisfies Meta<typeof DiffFigures>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { added: 6757, removed: 211 },
};

/**
 * A pure addition — most of any diff. The zero is DRAWN, so it cannot be
 * mistaken for an unmeasured side, and MUTED, so fifty of them in a column do
 * not colour it for a loss that never happened.
 */
export const MeasuredZero: Story = {
  args: { added: 118, removed: 0 },
};

/** A deletion, which really did add nothing. */
export const PureDeletion: Story = {
  args: { added: 0, removed: 94 },
};

/**
 * Not measured — a binary file, an untracked file past the read's body budget,
 * a pull request `gh` could not be asked about. Inline, that draws NOTHING: a
 * zero here would assert a change of nothing.
 */
export const NotMeasured: Story = {
  args: { added: null, removed: null },
};

/** One side unmeasured is still honest about the other. */
export const HalfMeasured: Story = {
  args: { added: 12, removed: null },
};

/**
 * The `columns` layout, which reserves each side's width so figures line up
 * down a list — including on the row that has nothing to say, whose gap is what
 * keeps its neighbours' numbers in line.
 */
export const Columns: Story = {
  args: { added: 6757, removed: 211, layout: 'columns' },
  render: (args) => (
    <div className="flex w-64 flex-col gap-1">
      <DiffFigures {...args} />
      <DiffFigures added={8} removed={0} layout="columns" />
      <DiffFigures added={127} removed={3} layout="columns" />
      <DiffFigures added={null} removed={null} layout="columns" />
    </div>
  ),
};
