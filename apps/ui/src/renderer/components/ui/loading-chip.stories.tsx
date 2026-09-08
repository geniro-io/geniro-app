import type { Meta, StoryObj } from '@storybook/react-vite';

import { LoadingChip } from './loading-chip';

const meta = {
  title: 'Primitives/LoadingChip',
  component: LoadingChip,
  args: { noun: 'effort levels' },
} satisfies Meta<typeof LoadingChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** The task panel's own wording: a generic label, the noun only in the a11y name. */
export const GenericWording: Story = {
  args: { noun: 'approval modes' },
};

/** The composer's wording: the noun printed on the chip, and a CLI-specific title. */
export const NamedWording: Story = {
  args: {
    noun: 'models',
    title: 'Loading models for cursor-agent…',
    visibleText: 'Loading models…',
  },
};
