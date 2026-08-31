import type { Meta, StoryObj } from '@storybook/react-vite';

import { ConnectionBanner } from './connection-banner';

const meta = {
  title: 'Components/ConnectionBanner',
  component: ConnectionBanner,
  args: {
    reason: null,
    onRetry: () => undefined,
  },
} satisfies Meta<typeof ConnectionBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithReason: Story = {
  args: {
    reason: 'connect ECONNREFUSED 127.0.0.1:47615',
  },
};

export const Retrying: Story = {
  args: {
    reason: 'connect ECONNREFUSED 127.0.0.1:47615',
    retrying: true,
  },
};
