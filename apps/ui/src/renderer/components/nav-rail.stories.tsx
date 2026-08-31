import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { NavRail } from './nav-rail';

const meta = {
  title: 'Components/NavRail',
  component: NavRail,
  args: {
    // onNavigate/collapsed/onToggleCollapsed are dummy defaults satisfying
    // the required-args type — the render below owns real state for both.
    view: 'chats',
    hydrated: true,
    collapsed: false,
    onNavigate: () => undefined,
    onToggleCollapsed: () => undefined,
  },
  render: (args) => {
    const [view, setView] = useState(args.view);
    const [collapsed, setCollapsed] = useState(args.collapsed ?? false);
    return (
      <div className="flex h-[520px] w-fit overflow-hidden rounded-lg border border-border">
        <NavRail
          {...args}
          view={view}
          collapsed={collapsed}
          onNavigate={setView}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
        />
      </div>
    );
  },
} satisfies Meta<typeof NavRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Collapsed: Story = {
  args: { collapsed: true },
};

export const OnWorkflowsView: Story = {
  args: { view: 'workflows' },
};
