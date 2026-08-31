import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { SegmentedControl } from './segmented-control';

type Period = 'today' | 'week' | 'month' | 'all';

const PERIODS: readonly { id: Period; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All time' },
];

// Generic over its option id, so the meta is written against a concrete
// instantiation rather than relying on inference from args.
const meta = {
  title: 'Primitives/SegmentedControl',
  component: SegmentedControl<Period>,
  args: {
    ariaLabel: 'Stats period',
    options: PERIODS,
    value: 'week',
    onSelect: () => {},
  },
} satisfies Meta<typeof SegmentedControl<Period>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => {
    function SegmentedControlDemo(): React.JSX.Element {
      const [value, setValue] = useState<Period>('week');
      return (
        <SegmentedControl
          ariaLabel="Stats period"
          options={PERIODS}
          value={value}
          onSelect={setValue}
        />
      );
    }
    return <SegmentedControlDemo />;
  },
};

export const Small: Story = {
  render: () => {
    function SegmentedControlDemo(): React.JSX.Element {
      const [value, setValue] = useState<Period>('today');
      return (
        <SegmentedControl
          ariaLabel="Chat scope"
          options={PERIODS}
          value={value}
          size="sm"
          onSelect={setValue}
        />
      );
    }
    return <SegmentedControlDemo />;
  },
};
