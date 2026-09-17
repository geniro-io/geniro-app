import type { Meta, StoryObj } from '@storybook/react-vite';

import { PROFILE_COLORS } from '../../../shared/contracts';
import { PALETTE_LABEL } from './palette';
import { PaletteDot } from './palette-dot';

const meta = {
  title: 'Primitives/PaletteDot',
  component: PaletteDot,
  args: { color: 'blue', size: 'md' },
  argTypes: {
    color: { control: 'select', options: PROFILE_COLORS },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
  },
} satisfies Meta<typeof PaletteDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WholePalette: Story = {
  render: () => (
    <div className="flex flex-col gap-2 text-sm">
      {PROFILE_COLORS.map((color) => (
        <span key={color} className="flex items-center gap-2">
          <PaletteDot color={color} />
          {PALETTE_LABEL[color]}
        </span>
      ))}
    </div>
  ),
};
