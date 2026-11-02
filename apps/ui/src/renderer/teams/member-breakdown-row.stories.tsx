import type { Meta, StoryObj } from '@storybook/react-vite';

import { categoryToken } from '../stats/charts/chart-theme';
import { MemberBreakdownRow } from './member-breakdown-row';

const meta = {
  title: 'Teams/MemberBreakdownRow',
  component: MemberBreakdownRow,
  args: {
    memberId: 'ada',
    name: 'Ada',
    share: 0.42,
    figures: ['9 runs', '$17', '6h'],
  },
  decorators: [(story) => <ul className="w-[720px] list-none">{story()}</ul>],
} satisfies Meta<typeof MemberBreakdownRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Measured: Story = {};

export const NotMeasured: Story = {
  args: { share: null, figures: [null, null, null] },
};

export const Several: Story = {
  render: () => (
    <>
      {[
        ['ada', 'Ada', 0.42, '$17'],
        ['linus', 'Linus', 0.33, '$14'],
        ['grace', 'Grace', 0.25, '$10'],
      ].map(([id, name, share, cost], index) => (
        <MemberBreakdownRow
          key={id as string}
          memberId={id as string}
          name={name as string}
          share={share as number}
          figures={['—', cost as string, '—']}
          color={categoryToken(index)}
        />
      ))}
    </>
  ),
};
