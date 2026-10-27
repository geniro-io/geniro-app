import type { Meta, StoryObj } from '@storybook/react-vite';

import { StageChangeRow } from './stage-change-row';
import { ThreadUiMemoryContext } from './thread-ui-memory';

const meta = {
  title: 'Chats/StageChangeRow',
  component: StageChangeRow,
  args: {
    actor: 'lead',
    time: '14:25',
    change: {
      action: 'complete',
      stageId: 'investigate',
      stageTitle: 'Investigation',
      next: 'fix',
      text: 'Cause found: calc.py add() returns a - b, but the README says add(a, b) should return the sum. Taking the Fix branch.',
      rev: 1,
      by: { kind: 'agent', nodeId: 'lead' },
    },
    nextTitle: 'Fix',
  },
  decorators: [
    (story) => (
      <ThreadUiMemoryContext.Provider value="story-run">
        <div className="w-[640px] bg-background p-4">{story()}</div>
      </ThreadUiMemoryContext.Provider>
    ),
  ],
} satisfies Meta<typeof StageChangeRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompletedAtAFork: Story = {};

export const Completed: Story = {
  args: {
    nextTitle: undefined,
    change: {
      ...meta.args.change,
      stageId: 'review',
      stageTitle: 'Review',
      next: undefined,
      text: 'Diff is one line in calc.py; add(2, 3) returns 5, matching the README.',
    },
  },
};

export const LongSummary: Story = {
  args: {
    change: {
      ...meta.args.change,
      text: 'Cause found: calc.py add() returns a - b, but the README says add(a, b) should return the sum. The tests in test_calc.py only cover mul, so nothing caught it; the git log shows the subtraction arrived in the refactor three commits ago, alongside a rename that touched every call site. Taking the Fix branch rather than Implementation, because the function exists and is wrong, not missing.',
    },
  },
};

export const Skipped: Story = {
  args: {
    nextTitle: 'Ship',
    change: {
      ...meta.args.change,
      action: 'skip',
      stageTitle: 'Review',
      next: 'ship',
      text: 'The change is docs only.',
    },
  },
};

export const ReopenedByYou: Story = {
  args: {
    actor: 'You',
    nextTitle: undefined,
    change: {
      ...meta.args.change,
      action: 'reopen',
      stageTitle: 'Review',
      next: undefined,
      text: 'The screenshots are missing.',
      by: { kind: 'user', via: 'desktop' },
    },
  },
};

export const NudgedByGeniro: Story = {
  args: {
    actor: 'geniro',
    nextTitle: undefined,
    change: {
      ...meta.args.change,
      action: 'nudge',
      stageTitle: 'Review',
      next: undefined,
      text: '',
      by: { kind: 'system' },
    },
  },
};

export const Stalled: Story = {
  args: {
    actor: 'geniro',
    nextTitle: undefined,
    change: {
      ...meta.args.change,
      action: 'stalled',
      stageTitle: 'Review',
      next: undefined,
      text: '',
      by: { kind: 'system' },
    },
  },
};

export const InATranscript: Story = {
  render: (args) => (
    <div className="flex flex-col gap-1">
      <StageChangeRow {...args} />
      <StageChangeRow
        actor="lead"
        time="14:27"
        change={{
          ...args.change,
          action: 'complete',
          stageId: 'fix',
          stageTitle: 'Fix',
          next: undefined,
          text: 'add() now returns a + b; the README example passes.',
        }}
      />
      <StageChangeRow
        actor="geniro"
        time="14:41"
        change={{
          ...args.change,
          action: 'nudge',
          stageId: 'review',
          stageTitle: 'Review',
          next: undefined,
          text: '',
          by: { kind: 'system' },
        }}
      />
      <StageChangeRow
        actor="geniro"
        time="15:02"
        change={{
          ...args.change,
          action: 'stalled',
          stageId: 'review',
          stageTitle: 'Review',
          next: undefined,
          text: '',
          by: { kind: 'system' },
        }}
      />
    </div>
  ),
};
