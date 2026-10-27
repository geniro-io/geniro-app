import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  DEV_TEAM_VERSIONS,
  NEVER_RUN_VERSIONS,
} from '../__fixtures__/workflow-versions';
import { Button } from '../components/ui/button';
import { WorkflowVersionsDialog } from './workflow-versions-dialog';

type DialogProps = Parameters<typeof WorkflowVersionsDialog>[0];

/** Opens by default, and reopens from a button once closed. */
function Stateful(
  props: Omit<DialogProps, 'open' | 'onClose'>,
): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Versions…
      </Button>
      <WorkflowVersionsDialog
        {...props}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

const meta = {
  title: 'Workflows/WorkflowVersionsDialog',
  component: WorkflowVersionsDialog,
  args: {
    open: true,
    onClose: () => undefined,
    workflowName: 'Dev Team',
    data: DEV_TEAM_VERSIONS,
    loading: false,
    error: null,
    onRetry: () => undefined,
    onRestore: async () => undefined,
  },
  render: (args) => <Stateful {...args} />,
  decorators: [(story) => <div className="h-[640px]">{story()}</div>],
} satisfies Meta<typeof WorkflowVersionsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two numbered versions, an inferred one, and runs that kept no graph copy. Press the newest to see its diff, or #1 to restore it. */
export const Versions: Story = {};

export const Loading: Story = {
  args: { data: null, loading: true },
};

export const LoadFailed: Story = {
  args: {
    data: null,
    loading: false,
    error: 'daemon GET /v1/stats/workflow-versions failed (500): boom',
  },
};

export const NeverRun: Story = {
  args: { data: NEVER_RUN_VERSIONS, workflowName: 'Fresh workflow' },
};

/** A restore held back while the builder chat's agent works. */
export const RestoreHeldBack: Story = {
  args: {
    restoreBlockedReason: 'The chat’s agent is working on this workflow.',
  },
};
