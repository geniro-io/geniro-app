import type { Meta, StoryObj } from '@storybook/react-vite';

import { aProject } from '../__fixtures__/projects';
import { AutopilotMark, FAILURE_BREAKER_THRESHOLD } from './autopilot-mark';

const meta = {
  title: 'Components/AutopilotMark',
  component: AutopilotMark,
  args: { project: aProject({ name: 'Billing', autopilotEnabled: true }) },
} satisfies Meta<typeof AutopilotMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Armed: Story = {};

export const Tripped: Story = {
  args: {
    project: aProject({
      name: 'Billing',
      autopilotEnabled: true,
      autopilotFailureStreak: FAILURE_BREAKER_THRESHOLD,
    }),
  },
};

export const WaitingForUsageLimit: Story = {
  args: {
    project: aProject({
      name: 'Billing',
      autopilotEnabled: true,
      autopilotLimitUntil: '2099-11-08T11:01:00.000Z',
    }),
  },
};

export const Off: Story = {
  args: { project: aProject({ name: 'Billing' }) },
};
