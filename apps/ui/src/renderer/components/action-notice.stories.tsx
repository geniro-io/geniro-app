import type { Meta, StoryObj } from '@storybook/react-vite';

import { ActionNotice } from './action-notice';

const meta = {
  title: 'Components/ActionNotice',
  component: ActionNotice,
  args: {
    message: 'Learning signal in “Refactor the parser” · Claude · ≈$0.04',
    onDismiss: () => undefined,
  },
  decorators: [(story) => <div className="w-[480px]">{story()}</div>],
} satisfies Meta<typeof ActionNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithActions: Story = {
  args: {
    actions: [
      { label: 'Extract lessons', onAction: () => undefined },
      {
        label: 'Change model…',
        onAction: () => undefined,
        variant: 'outline',
      },
      { label: 'Not now', onAction: () => undefined, variant: 'ghost' },
    ],
  },
};

export const LongMessage: Story = {
  args: {
    message:
      'Reflection failed for “Migrate the billing exports to the new ledger schema and check every archived invoice” — try again from Settings → Memory',
    actions: [{ label: 'Try again', onAction: () => undefined }],
  },
};
