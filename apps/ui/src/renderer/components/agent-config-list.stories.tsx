import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import type { CliDetection, CliKind } from '../../shared/contracts';
import {
  AgentConfigList,
  type AgentConfigListProps,
} from './agent-config-list';

const READY_CLIS: CliDetection[] = [
  {
    kind: 'claude',
    found: true,
    path: '/usr/local/bin/claude',
    version: '2.1.235',
    loggedIn: true,
  },
  {
    kind: 'cursor-agent',
    found: true,
    path: '/usr/local/bin/cursor-agent',
    version: '2026.08.11',
    loggedIn: true,
  },
];

/** Installed and detected, but the CLI reports itself signed out. */
const SIGNED_OUT_CLIS: CliDetection[] = [
  { ...READY_CLIS[0]!, loggedIn: false },
  READY_CLIS[1]!,
];

/** Drives the pieces of state a real Settings/Onboarding screen owns, so the
 * cards actually expand and the binary-path fields actually type. */
function AgentConfigListDemo(
  props: Omit<
    AgentConfigListProps,
    'open' | 'onToggle' | 'binaryPaths' | 'onBinaryPathChange'
  >,
): React.JSX.Element {
  const [open, setOpen] = useState<Partial<Record<CliKind, boolean>>>({
    claude: true,
  });
  const [binaryPaths, setBinaryPaths] = useState<
    Partial<Record<CliKind, string>>
  >({});
  return (
    <div className="w-[420px]">
      <AgentConfigList
        {...props}
        open={open}
        onToggle={(kind) =>
          setOpen((prev) => ({ ...prev, [kind]: !prev[kind] }))
        }
        binaryPaths={binaryPaths}
        onBinaryPathChange={(kind, value) =>
          setBinaryPaths((prev) => ({ ...prev, [kind]: value }))
        }
      />
    </div>
  );
}

const meta = {
  title: 'Components/AgentConfigList',
  component: AgentConfigListDemo,
  args: {
    clis: READY_CLIS,
    onBrowse: () => undefined,
  },
} satisfies Meta<typeof AgentConfigListDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Detecting: Story = {
  args: { clis: null },
};

export const NotFound: Story = {
  args: {
    clis: [
      {
        kind: 'claude',
        found: false,
        path: null,
        version: null,
        loggedIn: null,
      },
      {
        kind: 'cursor-agent',
        found: false,
        path: null,
        version: null,
        loggedIn: null,
      },
    ],
  },
};

export const SignedOut: Story = {
  args: {
    clis: SIGNED_OUT_CLIS,
    onSignIn: () => undefined,
    onSignOut: () => undefined,
  },
};

export const SigningIn: Story = {
  args: {
    clis: SIGNED_OUT_CLIS,
    onSignIn: () => undefined,
    onSignOut: () => undefined,
    signingIn: 'claude',
    login: {
      kind: 'claude',
      session: {
        id: 'session-1',
        agent: 'claude',
        status: 'waiting',
        url: 'https://claude.ai/oauth/authorize?code=abc123',
        message: null,
      },
      error: null,
      onSubmitCode: () => undefined,
      onCancel: () => undefined,
      onDismiss: () => undefined,
    },
  },
};
