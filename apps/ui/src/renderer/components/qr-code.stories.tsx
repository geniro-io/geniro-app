import type { Meta, StoryObj } from '@storybook/react-vite';

import { QrCode } from './qr-code';

const meta = {
  title: 'Components/QrCode',
  component: QrCode,
  args: {
    value: 'http://geniro-mac.local:47616/#/chats/2f6b1c9e-…',
  },
  decorators: [(story) => <div className="p-4">{story()}</div>],
} satisfies Meta<typeof QrCode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Small: Story = {
  args: { size: 96 },
};

export const Large: Story = {
  args: { size: 240 },
};
