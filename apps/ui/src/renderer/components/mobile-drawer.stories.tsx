import type { Meta, StoryObj } from '@storybook/react-vite';

import { MobileDrawer } from './mobile-drawer';

const meta = {
  title: 'Components/MobileDrawer',
  component: MobileDrawer,
  args: {
    open: true,
    onClose: () => undefined,
    children: (
      <div className="flex flex-col gap-1 p-3 text-sm">
        <div className="mb-1 font-medium">Chats</div>
        <div className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent/50">
          Review the diff
        </div>
        <div className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent/50">
          Fix the flaky test
        </div>
      </div>
    ),
  },
  // `max-sm:*` classes only take effect below Tailwind's `sm` breakpoint
  // (640px), which the catalog's own canvas is routinely wider than — the
  // same limitation `pairing-screen.stories.tsx`'s `PhoneWidth` already
  // states. Boxed narrow so the panel's OWN look is still legible, even
  // though the fixed-position slide-in chrome itself needs a real phone
  // width (or the running app) to see.
  decorators: [
    (story) => (
      <div className="relative h-[420px] w-[390px] overflow-hidden rounded-lg border border-border bg-background">
        {story()}
      </div>
    ),
  ],
} satisfies Meta<typeof MobileDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/**
 * The chat list's own shape — an `aside` landmark carrying its border,
 * background and width, over the same drawer mechanics as the default `div`
 * above (see `chats/Chats.tsx`).
 */
export const AsListPanel: Story = {
  args: {
    as: 'aside',
    className:
      'flex flex-col border-r border-border bg-sidebar w-[85vw] max-w-[320px]',
  },
};
