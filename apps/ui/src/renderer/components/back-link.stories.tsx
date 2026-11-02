import type { Meta, StoryObj } from '@storybook/react-vite';

import { BackLink } from './back-link';

const meta = {
  title: 'Components/BackLink',
  component: BackLink,
  args: { label: 'Projects', onClick: () => {} },
} satisfies Meta<typeof BackLink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Projects: Story = {};

export const Teams: Story = { args: { label: 'Teams' } };
