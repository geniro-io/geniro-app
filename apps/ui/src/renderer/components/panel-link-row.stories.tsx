import type { Meta, StoryObj } from '@storybook/react-vite';
import { FileText, GitPullRequest } from 'lucide-react';

import { PanelActionRow, PanelLinkRow } from './panel-link-row';

const meta = {
  title: 'Components/PanelLinkRow',
  component: PanelLinkRow,
  args: {
    href: 'https://github.com/geniro-io/geniro-app/pull/81',
    title: 'feat/shelf-labels-and-config-profiles',
    icon: (
      <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
    ),
  },
  decorators: [
    (story) => <div className="flex w-72 flex-col gap-1.5">{story()}</div>,
  ],
} satisfies Meta<typeof PanelLinkRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithMeta: Story = {
  args: { meta: '#81' },
};

export const LongTitleTruncates: Story = {
  args: {
    title:
      'A pull request title long enough that it has to truncate rather than wrap or overflow the panel row',
    meta: 'PR #124',
  },
};

export const InAppAction: Story = {
  render: () => (
    <PanelActionRow
      onClick={() => undefined}
      title="Open the workflow builder"
      icon={<FileText className="size-3.5 shrink-0 text-muted-foreground" />}
      meta="⌥⌘L"
    />
  ),
};
