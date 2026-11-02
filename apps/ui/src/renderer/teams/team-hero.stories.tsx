import type { Meta, StoryObj } from '@storybook/react-vite';

import { TeamHero, UNMEASURED_FIGURES } from './team-hero';
import { WarningPill } from './warning-pill';

const PEOPLE = [
  { key: 'ada', name: 'Ada' },
  {
    key: 'linus',
    name: 'Linus',
    avatar: { kind: 'emoji' as const, value: '🐧', tone: 'avatar-7' },
  },
  { key: 'grace', name: 'Grace' },
  { key: 'margaret', name: 'Margaret' },
  { key: 'alan', name: 'Alan' },
  { key: 'barbara', name: 'Barbara' },
  { key: 'edsger', name: 'Edsger' },
];

const meta = {
  title: 'Teams/TeamHero',
  component: TeamHero,
  args: {
    name: 'Dev Team',
    description:
      'Plans a change, builds it, reviews it and ships a pull request.',
    people: PEOPLE,
    memberCount: 7,
    stageCount: 4,
    figures: { runs: 23, cost: '$41', worked: '14h' },
  },
  decorators: [(story) => <div className="w-[880px] p-6">{story()}</div>],
} satisfies Meta<typeof TeamHero>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Measured: Story = {};

export const LongDescription: Story = {
  args: {
    description: Array.from(
      { length: 8 },
      () =>
        'The Senior Engineer owns a piece of work end to end — it scopes it, builds from a spec when the user wanted one, debugs a bug of unknown cause and reports a computed delivery verdict.',
    ).join(' '),
  },
};

export const NotMeasured: Story = { args: { figures: UNMEASURED_FIGURES } };

export const NeedsSetup: Story = {
  args: {
    warning: (
      <WarningPill
        onGoToMember={() => {}}
        problems={[
          {
            key: 'a',
            members: [{ id: 'ada', name: 'Ada' }],
            message: 'MCP github needs sign-in',
            level: 'warning',
          },
          {
            key: 'b',
            members: [{ id: 'linus', name: 'Linus' }],
            message: 'codex is not installed',
            level: 'error',
          },
        ]}
      />
    ),
  },
};
