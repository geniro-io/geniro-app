import type { Meta, StoryObj } from '@storybook/react-vite';

import { AgentGlyph } from './agent-glyph';

const meta = {
  title: 'Components/AgentGlyph',
  component: AgentGlyph,
  args: { icon: 'bot' },
} satisfies Meta<typeof AgentGlyph>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BotIcon: Story = {};

export const TerminalIcon: Story = {
  args: { icon: 'terminal' },
};

export const CodeIcon: Story = {
  args: { icon: 'code' },
};
