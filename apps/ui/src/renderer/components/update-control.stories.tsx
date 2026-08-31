import type { Meta, StoryObj } from '@storybook/react-vite';

import type { FooterUpdate } from '../updates/update-status';
import { UpdateControl } from './update-control';

const meta = {
  title: 'Components/UpdateControl',
  component: UpdateControl,
  args: {
    update: {
      kind: 'install',
      label: '1.49.0',
      title: 'Update to Geniro 1.49.0',
    } satisfies FooterUpdate,
    onInstall: () => undefined,
    onRelaunch: () => undefined,
  },
} satisfies Meta<typeof UpdateControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Progress: Story = {
  args: {
    update: {
      kind: 'progress',
      label: '42%',
      title: 'Downloading Geniro 1.49.0…',
    },
  },
};

export const Restart: Story = {
  args: {
    update: {
      kind: 'restart',
      label: 'restart',
      title: 'Geniro 1.48.5 is installed — restart to use it.',
    },
  },
};

export const Failed: Story = {
  args: {
    update: {
      kind: 'error',
      label: 'retry',
      title: 'The download failed: it made no progress for 3 minutes.',
    },
  },
};

export const Readout: Story = {
  args: {
    update: {
      kind: 'readout',
      label: '1.49.0',
      title: 'Update with: brew upgrade --cask geniro',
    },
  },
};
