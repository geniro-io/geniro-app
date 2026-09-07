import type { Meta, StoryObj } from '@storybook/react-vite';

import { ContextMenu, useContextMenu } from './context-menu';
import type { MenuGroup } from './menu';

const ROW_GROUPS: MenuGroup[] = [
  {
    items: [
      { value: 'rename', label: 'Rename' },
      { value: 'pin', label: 'Pin to top of group' },
    ],
  },
  {
    items: [
      { value: 'archive', label: 'Archive' },
      { value: 'delete', label: 'Delete permanently', tone: 'destructive' },
    ],
  },
];

const meta = {
  title: 'Primitives/ContextMenu',
  component: ContextMenu,
  args: {
    point: { x: 120, y: 80 },
    groups: ROW_GROUPS,
    onSelect: () => {},
    onClose: () => {},
  },
} satisfies Meta<typeof ContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Right-click the surface. A story that only rendered the panel would document
 * the rows and not the one thing this component adds — that it opens where the
 * pointer is — so the gesture is the story.
 */
export const Playground: Story = {
  render: () => {
    function ContextMenuDemo(): React.JSX.Element {
      const { point, onContextMenu, close } = useContextMenu();
      return (
        <div
          onContextMenu={onContextMenu}
          className="flex h-64 items-center justify-center rounded-md border border-border border-dashed text-sm text-muted-foreground">
          Right-click anywhere in this box
          <ContextMenu
            point={point}
            groups={ROW_GROUPS}
            onSelect={close}
            onClose={close}
          />
        </div>
      );
    }
    return <ContextMenuDemo />;
  },
};
