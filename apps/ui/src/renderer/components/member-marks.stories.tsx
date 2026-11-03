import type { Meta, StoryObj } from '@storybook/react-vite';

import { MEMBER_VERDICTS, MemberMarks } from './member-marks';

const meta = {
  title: 'Components/MemberMarks',
  component: MemberMarks,
  args: { usefulness: 4, quality: 2, verdict: 'tune' },
} satisfies Meta<typeof MemberMarks>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tune: Story = {};

export const Strong: Story = {
  args: { usefulness: 5, quality: 5, verdict: 'keep' },
};

export const EveryVerdict: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {MEMBER_VERDICTS.map((verdict, index) => (
        <MemberMarks
          key={verdict}
          usefulness={5 - index}
          quality={Math.max(1, 4 - index)}
          verdict={verdict}
        />
      ))}
    </div>
  ),
};
