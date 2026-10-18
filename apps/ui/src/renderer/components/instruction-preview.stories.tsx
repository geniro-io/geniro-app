import type { Meta, StoryObj } from '@storybook/react-vite';

import { InstructionPreview } from './instruction-preview';

const meta = {
  title: 'Components/InstructionPreview',
  component: InstructionPreview,
  args: {
    text: '## How your response is displayed\n\nYou are running inside Geniro, a desktop app. Your replies are rendered in a chat transcript as rich GitHub-flavored markdown.',
  },
} satisfies Meta<typeof InstructionPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithCaption: Story = {
  args: {
    caption: 'Claude Code',
    text: '## Work you leave running\n\nSub-agents you start in the background keep running after you end your turn.',
  },
};
