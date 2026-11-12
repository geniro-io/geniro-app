import type { Meta, StoryObj } from '@storybook/react-vite';
import { Globe, TerminalIcon } from 'lucide-react';
import { useState } from 'react';

import type { ProfileColor } from '../../shared/contracts';
import { ColorRenameMenu } from './color-rename-menu';

function Stateful({
  initial,
  emptyIcon,
  side,
}: {
  initial: ProfileColor | null;
  emptyIcon: React.ReactNode;
  side: 'top' | 'bottom';
}): React.JSX.Element {
  const [color, setColor] = useState(initial);
  const [renames, setRenames] = useState(0);
  return (
    <div className="flex h-[360px] items-center gap-2 p-8 text-sm">
      <ColorRenameMenu
        color={color}
        onRecolor={setColor}
        onRename={() => setRenames((count) => count + 1)}
        ariaLabel="Options for tab Staging login"
        emptyIcon={emptyIcon}
        side={side}
      />
      <span>Staging login</span>
      <span className="text-muted-foreground">Rename asked {renames}×</span>
    </div>
  );
}

const meta = {
  title: 'Components/ColorRenameMenu',
  component: ColorRenameMenu,
  args: {
    color: 'teal',
    onRecolor: () => {},
    onRename: () => {},
    ariaLabel: 'Options for tab Staging login',
    emptyIcon: <Globe aria-hidden="true" className="size-3" />,
    side: 'bottom',
  },
} satisfies Meta<typeof ColorRenameMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Coloured: Story = {
  render: () => (
    <Stateful
      initial="teal"
      emptyIcon={<Globe aria-hidden="true" className="size-3" />}
      side="bottom"
    />
  ),
};

export const NoColour: Story = {
  render: () => (
    <Stateful
      initial={null}
      emptyIcon={<TerminalIcon aria-hidden="true" className="size-3" />}
      side="bottom"
    />
  ),
};
