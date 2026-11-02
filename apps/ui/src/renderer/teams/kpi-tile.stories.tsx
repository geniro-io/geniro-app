import type { Meta, StoryObj } from '@storybook/react-vite';

import { SERIES } from '../stats/charts/chart-theme';
import { KpiStrip, KpiTile } from './kpi-tile';

const meta = {
  title: 'Teams/KpiTile',
  component: KpiTile,
  args: { caption: 'Runs', value: '23', trend: [2, 3, 1, 4, 6, 5, 7] },
} satisfies Meta<typeof KpiTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Measured: Story = {};

export const NotMeasured: Story = { args: { value: null, trend: null } };

export const WithGapsAndNote: Story = {
  args: {
    caption: 'Cost',
    value: '$41.20',
    trend: [4, 6, null, 9, null, 8, 10],
    note: 'incl. $6.40 estimated',
  },
};

export const Strip: Story = {
  render: () => (
    <div className="w-[880px]">
      <KpiStrip>
        <KpiTile caption="Runs" value="23" trend={[2, 3, 1, 4, 6, 5, 7]} />
        <KpiTile
          caption="Cost"
          value="$41"
          trend={[4, 6, 5, 9, 7, 8, 10]}
          color={SERIES.spend}
        />
        <KpiTile caption="Turns" value="312" trend={null} />
        <KpiTile caption="Worked time" value="14h" trend={[1, 2, 2, 3, 2, 4]} />
        <KpiTile caption="Outcomes" value={null} />
      </KpiStrip>
    </div>
  ),
};
