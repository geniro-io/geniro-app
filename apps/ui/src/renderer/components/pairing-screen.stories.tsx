import type { Meta, StoryObj } from '@storybook/react-vite';

import { PairingScreen } from './pairing-screen';

const meta = {
  title: 'Components/PairingScreen',
  component: PairingScreen,
  args: {
    onPaired: () => undefined,
  },
} satisfies Meta<typeof PairingScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const PhoneWidth: Story = {
  // The screen this is FOR — a 390px viewport is the reader, not a resized
  // desktop dialog. Boxed so the catalog's own wide canvas doesn't imply a
  // wider design than the one that ships.
  decorators: [(story) => <div className="h-[700px] w-[390px]">{story()}</div>],
};
