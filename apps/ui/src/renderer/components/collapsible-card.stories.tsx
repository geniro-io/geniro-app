import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { CollapsibleCard } from './collapsible-card';
import { StatusDot } from './status-dot';

function CollapsibleCardDemo({
  initialOpen = false,
  bodyText = 'Set the full path to the binary, or leave it blank to auto-detect on PATH.',
}: {
  initialOpen?: boolean;
  bodyText?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div className="w-[360px]">
      <CollapsibleCard
        open={open}
        onToggle={() => setOpen((prev) => !prev)}
        header={
          <>
            <StatusDot tone="ok" />
            <span className="font-medium">claude</span>
            <span className="text-sm text-success">ready · 2.1.235</span>
          </>
        }>
        <p className="text-sm text-muted-foreground">{bodyText}</p>
      </CollapsibleCard>
    </div>
  );
}

const meta = {
  title: 'Components/CollapsibleCard',
  component: CollapsibleCardDemo,
} satisfies Meta<typeof CollapsibleCardDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Open: Story = {
  args: { initialOpen: true },
};

export const LongBody: Story = {
  args: {
    initialOpen: true,
    bodyText:
      'Set the full path to the binary. This overrides auto-detection on PATH — useful when several versions are installed side by side, or when the binary lives somewhere the shell PATH does not reach, such as a project-local install or a version manager shim that only resolves inside an interactive shell.',
  },
};
