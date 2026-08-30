import type { Meta, StoryObj } from '@storybook/react-vite';
import { FileText } from 'lucide-react';

import { PanelLinkRow } from './panel-link-row';
import { PanelSection } from './panel-section';

const meta = {
  title: 'Components/PanelSection',
  component: PanelSection,
  args: {
    label: 'Artifacts',
    children: (
      <PanelLinkRow
        href="https://example.com/report.html"
        title="Q3 findings report"
        icon={<FileText className="size-3.5 shrink-0 text-muted-foreground" />}
      />
    ),
  },
  decorators: [(story) => <div className="w-64 bg-background">{story()}</div>],
} satisfies Meta<typeof PanelSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Empty: Story = {
  args: { children: null },
};
