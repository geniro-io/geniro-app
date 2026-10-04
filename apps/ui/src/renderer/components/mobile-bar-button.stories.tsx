import type { Meta, StoryObj } from '@storybook/react-vite';
import { PanelRight } from 'lucide-react';

import { MobileBarButton } from './mobile-bar-button';

const meta = {
  title: 'Components/MobileBarButton',
  component: MobileBarButton,
  args: {
    label: 'Open run details',
    onClick: () => undefined,
    children: <PanelRight aria-hidden="true" />,
  },
  // The button is `fixed` and `sm:hidden`, so on the catalog's own canvas it
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
} satisfies Meta<typeof MobileBarButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The chat screen's run-details opener, at the band's trailing edge. */
export const RunDetails: Story = {
  args: { expanded: false, className: 'right-2' },
};
