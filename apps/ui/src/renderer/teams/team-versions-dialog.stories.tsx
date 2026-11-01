import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  DEV_TEAM_VERSIONS,
  EDITED_SINCE_LAST_RUN,
  NEVER_RUN_VERSIONS,
} from '../__fixtures__/team-versions';
import { Button } from '../components/ui/button';
import { TeamVersionsDialog } from './team-versions-dialog';

type DialogProps = Parameters<typeof TeamVersionsDialog>[0];

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
      <TeamVersionsDialog
        {...props}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

const meta = {
  title: 'Teams/TeamVersionsDialog',
  component: TeamVersionsDialog,
  args: {
    open: true,
    onClose: () => undefined,
    teamName: 'Dev Team',
    data: DEV_TEAM_VERSIONS,
    loading: false,
    error: null,
    onRetry: () => undefined,
    onRestore: async () => undefined,
  },
  render: (args) => <Stateful {...args} />,
  decorators: [(story) => <div className="h-[640px]">{story()}</div>],
} satisfies Meta<typeof TeamVersionsDialog>;

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
    error: 'daemon GET /v1/stats/team-versions failed (500): boom',
  },
};

export const NeverRun: Story = {
  args: { data: NEVER_RUN_VERSIONS, teamName: 'Fresh team' },
};

/** A restore held back while the builder chat's agent works. */
export const RestoreHeldBack: Story = {
  args: {
    restoreBlockedReason: 'The chat’s agent is working on this team.',
  },
};

/** The graph was edited after its last run: the library's graph is current and not numbered yet. */
export const EditedSinceLastRun: Story = {
  args: { data: EDITED_SINCE_LAST_RUN },
};
