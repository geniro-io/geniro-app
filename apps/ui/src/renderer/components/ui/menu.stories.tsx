import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';

import { Button } from './button';
import { Menu, type MenuGroup } from './menu';

const AGENT_GROUPS: MenuGroup[] = [
  {
    label: 'Agents',
    items: [
      { value: 'claude', label: 'Claude' },
      { value: 'cursor', label: 'Cursor', hint: 'ACP' },
    ],
  },
  {
    label: 'Workflows',
    items: [{ value: 'wf:dev-team', label: 'Dev team' }],
  },
  {
    items: [{ value: 'new', label: 'New configuration…', action: true }],
  },
];

const meta = {
  title: 'Primitives/Menu',
  component: Menu,
  args: {
    open: true,
    groups: AGENT_GROUPS,
    onSelect: () => {},
    onClose: () => {},
  },
} satisfies Meta<typeof Menu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Open by default, so the catalog shows the panel rather than an empty canvas. */
export const Playground: Story = {
  render: () => {
    function MenuDemo(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      const [value, setValue] = useState('claude');
      const triggerRef = useRef<HTMLButtonElement | null>(null);
      return (
        <div className="relative inline-block">
          <Button
            ref={triggerRef}
            variant="outline"
            onClick={() => setOpen((v) => !v)}>
            {value}
          </Button>
          <Menu
            open={open}
            groups={AGENT_GROUPS}
            value={value}
            side="bottom"
            // Load-bearing: the outside-click guard falls back to a
            // `[data-menu-trigger]` lookup, which `Button` does not carry — so
            // without the ref, mousedown on the trigger CLOSES the menu and the
            // click reopens it, and the primitive's own catalog entry
            // demonstrates a toggle that looks broken.
            triggerRef={triggerRef}
            onSelect={setValue}
            onClose={() => setOpen(false)}
          />
        </div>
      );
    }
    return <MenuDemo />;
  },
};

export const WithSearch: Story = {
  render: () => {
    function MenuDemo(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      const [value, setValue] = useState('claude');
      const triggerRef = useRef<HTMLButtonElement | null>(null);
      return (
        <div className="relative inline-block">
          <Button
            ref={triggerRef}
            variant="outline"
            onClick={() => setOpen((v) => !v)}>
            {value}
          </Button>
          <Menu
            open={open}
            groups={AGENT_GROUPS}
            value={value}
            side="bottom"
            searchPlaceholder="Search agents…"
            triggerRef={triggerRef}
            onSelect={setValue}
            onClose={() => setOpen(false)}
          />
        </div>
      );
    }
    return <MenuDemo />;
  },
};

export const Empty: Story = {
  render: () => (
    <div className="relative inline-block">
      <Button variant="outline">No matches</Button>
      <Menu
        open
        groups={[]}
        emptyLabel="Nothing to show"
        side="bottom"
        onSelect={() => {}}
        onClose={() => {}}
      />
    </div>
  ),
};
