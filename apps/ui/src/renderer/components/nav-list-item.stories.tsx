import type { Meta, StoryObj } from '@storybook/react-vite';

import { NavListItem } from './nav-list-item';
import { StatusDot } from './status-dot';

const meta = {
  title: 'Components/NavListItem',
  component: NavListItem,
  args: {
    active: false,
    title: 'Refactor the daemon supervisor',
    subtitle: '2 hours ago',
    onActivate: () => undefined,
  },
  decorators: [
    (story) => (
      <ul className="m-0 flex w-64 list-none flex-col gap-1 p-0">{story()}</ul>
    ),
  ],
} satisfies Meta<typeof NavListItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Active: Story = {
  args: { active: true },
};

export const LongTitleTruncates: Story = {
  args: {
    title:
      'Investigate why the pull-request capture pass never ran for threads opened while the window was in the background',
    subtitle: 'geniro-app · feat/pull-request-capture',
  },
};

export const CustomContent: Story = {
  render: (args) => (
    <NavListItem {...args}>
      <span className="truncate text-sm font-medium">Design review</span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <StatusDot tone="ok" />3 open threads
      </span>
    </NavListItem>
  ),
};
