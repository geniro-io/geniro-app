import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { BrowserHostCard } from './browser-host-card';

const meta = {
  title: 'Chats/BrowserHostCard',
  component: BrowserHostCard,
  args: {
    request: {
      host: 'staging.acme.dev',
      url: 'https://staging.acme.dev/login?next=%2Fadmin',
      memberName: 'QA',
    },
    verdict: null,
    onRespond: fn(),
  },
  decorators: [
    (story) => <div className="w-[560px] bg-background p-4">{story()}</div>,
  ],
} satisfies Meta<typeof BrowserHostCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {};

export const Approved: Story = { args: { verdict: true } };

export const AllowedForSession: Story = {
  args: { verdict: true, verdictOption: 'Allow for this session' },
};

export const Denied: Story = { args: { verdict: false } };

export const Expired: Story = { args: { expired: true } };
