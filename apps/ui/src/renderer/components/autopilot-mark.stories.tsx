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

export const Off: Story = {
  args: { project: aProject({ name: 'Billing' }) },
};
