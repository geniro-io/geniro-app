import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  ENGINEER,
  PLANNER,
  REVIEWER,
} from '../__fixtures__/member-performance';
import { MemberPerformance } from './member-performance';

const meta = {
  title: 'Teams/MemberPerformance',
  component: MemberPerformance,
  args: { row: REVIEWER, loading: false },
  decorators: [(story) => <div className="w-[420px] p-4">{story()}</div>],
} satisfies Meta<typeof MemberPerformance>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AssessedTwice: Story = {};

export const Kept: Story = { args: { row: ENGINEER } };

export const NotMeasured: Story = { args: { row: PLANNER } };

export const NoTurnYet: Story = { args: { row: null } };
