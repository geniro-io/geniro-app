import type { Meta, StoryObj } from '@storybook/react-vite';

import { ApprovalCard } from './approval-card';

/** What claude offers beside a one-time answer for a shell command. */
const SESSION_AND_ALWAYS = [
  {
    id: 'session',
    label: 'Allow for this session',
    allow: true,
    scope: 'session',
  },
  { id: 'always', label: 'Always allow', allow: true, scope: 'always' },
];

const meta = {
  title: 'Chats/ApprovalCard',
  component: ApprovalCard,
  args: {
    toolName: 'Bash',
    input: { command: 'mkdir -p probe-out && touch probe-out/marker.txt' },
    verdict: null,
    onRespond: () => {},
  },
  decorators: [
    (story) => (
      <div className="w-[560px] bg-background p-3 text-foreground">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof ApprovalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A permission whose CLI offers nothing past a one-time answer. */
export const ApproveOrDeny: Story = {};

/** The CLI's own remembering answers, between Approve and Deny. */
export const WithRememberingOptions: Story = {
  args: { options: SESSION_AND_ALWAYS },
};

/** A settled card says how long the answer lasts. */
export const ApprovedForTheSession: Story = {
  args: {
    options: SESSION_AND_ALWAYS,
    verdict: true,
    verdictOption: 'Allow for this session',
  },
};

/** An analysis's change to a project's instructions: its changed lines, written only on Apply. */
export const ProjectInstructionsChange: Story = {
  args: {
    toolName: 'save_project_instructions',
    input: {
      summary: 'Change the instructions of project Billing',
      projectId: 'p-billing',
      project: 'Billing',
      diff: [
        '@@ -1,5 +1,6 @@',
        ' Use pnpm, never npm or yarn.',
        ' Migrations live in packages/db/migrations.',
        '-Run the unit tests before you push.',
        '+Run pnpm test:unit and pnpm lint before you push.',
        ' Invoices are rounded half-even, per the finance team.',
        ' Never log a customer email.',
        '+Ask before changing a public API route.',
      ].join('\n'),
      old_string: [
        'Use pnpm, never npm or yarn.',
        'Migrations live in packages/db/migrations.',
        'Run the unit tests before you push.',
        'Invoices are rounded half-even, per the finance team.',
        'Never log a customer email.',
      ].join('\n'),
      new_string: [
        'Use pnpm, never npm or yarn.',
        'Migrations live in packages/db/migrations.',
        'Run pnpm test:unit and pnpm lint before you push.',
        'Invoices are rounded half-even, per the finance team.',
        'Never log a customer email.',
        'Ask before changing a public API route.',
      ].join('\n'),
      ids: ['P-1', 'P-2'],
    },
  },
};

/** A message to another thread, drawn whole under the title of the thread it reaches. */
export const MessageToThread: Story = {
  args: {
    toolName: 'message_thread',
    input: {
      thread: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      message:
        'The migration is in. Two open questions:\n1. Keep the old column until the next release?\n2. Backfill in one batch or by day?',
      wake: true,
    },
    threadTitle: 'Pelican',
  },
};

/** An Apply that could not be written reads as not saved. */
export const ProjectInstructionsNotSaved: Story = {
  args: {
    ...ProjectInstructionsChange.args,
    verdict: true,
    answer: 'the instructions were changed after the card was raised',
    outcome: 'not-saved',
  },
};
