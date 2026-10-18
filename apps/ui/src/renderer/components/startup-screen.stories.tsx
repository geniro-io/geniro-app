import type { Meta, StoryObj } from '@storybook/react-vite';

import { StartupScreen } from './startup-screen';

const meta = {
  title: 'Components/StartupScreen',
  component: StartupScreen,
  args: {
    since: Date.now(),
    onRetry: () => undefined,
  },
  decorators: [(story) => <div className="h-[520px]">{story()}</div>],
} satisfies Meta<typeof StartupScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Starting: Story = {};

export const SlowStart: Story = {
  args: {
    since: Date.now() - 18_000,
  },
};

export const Failed: Story = {
  args: {
    reason: 'daemon exited during startup (code 1)',
  },
};
