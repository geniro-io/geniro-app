import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { TeamMemoryTab, TeamStatsTab } from './team-insights';

const meta = {
  title: 'Teams/TeamInsights',
  component: TeamStatsTab,
  args: { runs: null },
  decorators: [(story) => <div className="w-[880px] p-4">{story()}</div>],
} satisfies Meta<typeof TeamStatsTab>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StatisticsEmpty: Story = {};

function MemoryStateful(): React.JSX.Element {
  const [query, setQuery] = useState('');
  return <TeamMemoryTab query={query} onQueryChange={setQuery} />;
}

export const MemoryEmpty: Story = { render: () => <MemoryStateful /> };
