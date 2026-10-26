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
