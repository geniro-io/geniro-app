import type { Meta, StoryObj } from '@storybook/react-vite';

import type { FooterUpdate } from '../updates/update-status';
import { TitleBar } from './title-bar';

const NO_UPDATE: FooterUpdate = { kind: 'none' };
const UPDATE_AVAILABLE: FooterUpdate = {
  kind: 'install',
  label: '1.49.0',
  title: 'Update to Geniro 1.49.0',
};
const DOWNLOADING: FooterUpdate = {
  kind: 'progress',
  label: '42%',
  title: 'Downloading Geniro 1.49.0…',
};
const READY: FooterUpdate = {
  kind: 'restart',
  label: 'restart',
  title: 'Geniro 1.48.5 is installed — restart to use it.',
};
const FAILED: FooterUpdate = {
  kind: 'error',
  label: 'retry',
  title: 'The download failed: it made no progress for 3 minutes.',
};

const meta = {
  title: 'Components/TitleBar',
  component: TitleBar,
  args: {
    title: 'Refactor the daemon supervisor',
    update: NO_UPDATE,
  },
  decorators: [
    (story) => (
      <div className="w-[900px] overflow-hidden rounded-lg border border-border">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof TitleBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const UpdateAvailable: Story = {
  args: { update: UPDATE_AVAILABLE, onInstallUpdate: () => undefined },
};

export const Downloading: Story = {
  args: { update: DOWNLOADING },
};

export const ReadyToRestart: Story = {
  args: { update: READY, onRelaunchUpdate: () => undefined },
};

export const UpdateFailed: Story = {
  args: { update: FAILED, onInstallUpdate: () => undefined },
};
