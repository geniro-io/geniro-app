import type { Meta, StoryObj } from '@storybook/react-vite';

import { NoteBox } from './note-box';

const meta = {
  title: 'Components/NoteBox',
  component: NoteBox,
  args: {
    children:
      '22 extra tools in every prompt, paid for on each turn — restart required.',
  },
} satisfies Meta<typeof NoteBox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const LongText: Story = {
  args: {
    children:
      'While the port is open any process on this machine can run code inside it. This note runs long enough to show how the box wraps across several lines without breaking its rounded shape or padding.',
  },
};
