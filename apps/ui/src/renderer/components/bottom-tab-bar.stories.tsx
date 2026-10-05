import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { BottomTabBar } from './bottom-tab-bar';

const meta = {
  title: 'Components/BottomTabBar',
  component: BottomTabBar,
  args: { view: 'chats', onNavigate: () => undefined },
  render: (args) => {
    const [view, setView] = useState(args.view);
    // The bar is `sm:hidden`, so the catalog shows it only with the canvas
    // narrowed to phone width (the viewport toolbar), as in the running app.
    return (
      <div className="flex h-[200px] w-[390px] flex-col justify-end border border-border bg-background">
        <BottomTabBar {...args} view={view} onNavigate={setView} />
      </div>
    );
  },
} satisfies Meta<typeof BottomTabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnChats: Story = {};

export const OnSettings: Story = {
  args: { view: 'settings' },
};
