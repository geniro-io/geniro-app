import type { Meta, StoryObj } from '@storybook/react-vite';
import { Menu, MessageSquare } from 'lucide-react';

import { DrawerOpener } from './drawer-opener';

const meta = {
  title: 'Components/DrawerOpener',
  component: DrawerOpener,
  args: {
    label: 'Open navigation',
    onClick: () => undefined,
    children: <Menu aria-hidden="true" />,
  },
  // The opener is `fixed` and `sm:hidden`, so on the catalog's own canvas it
  // would pin itself to the window and vanish at any width past 640px. The
  // decorator gives it a containing block of its own — a `fixed` element
  // resolves against the nearest TRANSFORMED ancestor — and stands in for the
  // title bar's `h-11` band so the vertical centring this component exists
  // for is what the story actually shows. The `sm:hidden` arm still needs a
  // real phone width (or the running app) to see.
  decorators: [
    (story) => (
      <div className="w-[390px] translate-x-0">
        <div className="relative h-11 border-b border-sidebar-border bg-sidebar">
          {story()}
        </div>
        <div className="h-24 bg-background" />
      </div>
    ),
  ],
} satisfies Meta<typeof DrawerOpener>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The app shell's nav-rail opener, at the band's leading edge. */
export const Navigation: Story = {
  args: { className: 'left-2', expanded: false },
};

/**
 * The chat list's own opener, which sits beside the one above (`left-14`
 * clears its `size-9` plus a gap) and carries the icon `NavRail` gives the
 * Chats destination.
 */
export const ChatList: Story = {
  args: {
    label: 'Open chat list',
    className: 'left-14 z-40',
    children: <MessageSquare aria-hidden="true" />,
  },
};
