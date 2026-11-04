import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  ENGINEER,
  PLANNER,
  REVIEWER,
  TUNED,
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

export const ManyChanges: Story = {
  args: {
    row: {
      ...REVIEWER,
      changes: [
        TUNED,
        {
          ...TUNED,
          from: { number: 2, current: false },
          to: { number: 3, current: false },
          kinds: ['instructions', 'character', 'blocks'],
          source: null,
          summary: null,
          recommendationIds: [],
          effect: 'mixed',
          moved: [
            {
              figure: 'cost per run',
              unit: 'usd',
              from: 49.29,
              to: 33.89,
              direction: 'better',
            },
            {
              figure: 'working time per run',
              unit: 'ms',
              from: 13_020_000,
              to: 21_360_000,
              direction: 'worse',
            },
          ],
        },
        {
          ...TUNED,
          from: { number: 1, current: false },
          to: { number: 2, current: false },
          kinds: ['pool', 'effort', 'stages'],
          source: 'builder',
          summary:
            'Moved PR visuals from the pr-visuals skill to a runbook: Team Settings, the playbook, Manager, Middle, Handyman and the stage.',
          recommendationIds: [],
          effect: 'too-few-runs',
          moved: [
            {
              figure: 'cost per run',
              unit: 'usd',
              from: 3.79,
              to: 78.06,
              direction: 'worse',
            },
          ],
        },
      ],
    },
  },
};
