import type { Meta, StoryObj } from '@storybook/react-vite';

import type { UpdateState } from '../../shared/contracts';
import type { UpdateController } from '../updates/use-update-state';
import { AppUpdateActions } from './app-update-actions';

const resolved = (): Promise<void> => Promise.resolve();

function controller(phase: UpdateState['phase']): UpdateController {
  return {
    state: {
      phase,
      version: '2.4.0',
      progress: null,
      message: null,
      failedPhase: null,
      currentVersion: '2.3.1',
      canInstall: true,
    },
    check: resolved,
    install: resolved,
    relaunch: resolved,
  };
}

const meta = {
  title: 'Components/AppUpdateActions',
  component: AppUpdateActions,
} satisfies Meta<typeof AppUpdateActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UpdateNow: Story = { args: { update: controller('available') } };

export const RestartNow: Story = { args: { update: controller('ready') } };
