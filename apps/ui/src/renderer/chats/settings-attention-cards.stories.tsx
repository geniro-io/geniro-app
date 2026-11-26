import type { Meta, StoryObj } from '@storybook/react-vite';

import type { CliDetection, UpdateState } from '../../shared/contracts';
import type { DaemonApis } from '../daemon-api';
import type { CliUpdatesController } from '../settings/use-cli-updates';
import type { UpdateController } from '../updates/use-update-state';
import type { CliLoginController } from '../use-cli-login';
import {
  AgentSignInCard,
  AgentUpdatesCard,
  AppUpdateCard,
  MemoryConflictsCard,
  ShareSignInCard,
} from './settings-attention-cards';

const noop = (): void => undefined;
const resolved = (): Promise<void> => Promise.resolve();

function detection(kind: CliDetection['kind'], latest: string): CliDetection {
  return {
    kind,
    found: true,
    path: `/usr/local/bin/${kind}`,
    version: '1.4.2',
    loggedIn: true,
    update: {
      available: true,
      latestVersion: latest,
      checkUnavailableReason: null,
    },
  };
}

const UPDATES: CliUpdatesController = {
  updating: new Set(['codex']),
  results: {},
  update: resolved,
  forget: resolved,
};

const LOGIN = {
  login: null,
  starting: null,
  start: resolved,
  startMcp: resolved,
  submitCode: resolved,
  cancel: resolved,
  dismiss: noop,
  error: null,
  errorTarget: null,
} as unknown as CliLoginController;

function appUpdate(phase: UpdateState['phase']): UpdateController {
  return {
    state: {
      phase,
      version: '2.4.0',
      progress: null,
      message: null,
      failedPhase: null,
      currentVersion: phase === 'ready' ? '2.4.0' : '2.3.1',
      canInstall: true,
    },
    check: resolved,
    install: resolved,
    relaunch: resolved,
  };
}

const nameOf = (kind: string): string =>
  ({ claude: 'Claude Code', codex: 'Codex', 'cursor-agent': 'Cursor' })[kind] ??
  kind;

const meta = {
  title: 'Chats/SettingsAttentionCards',
  decorators: [
    (story) => (
      <div className="flex w-[560px] flex-col gap-2.5 bg-background p-4">
        {story()}
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentUpdates: Story = {
  render: () => (
    <AgentUpdatesCard
      rows={[detection('claude', '1.5.0'), detection('codex', '0.31.0')]}
      updates={UPDATES}
      nameOf={nameOf}
    />
  ),
};

export const AgentSignIn: Story = {
  render: () => (
    <AgentSignInCard
      rows={[
        { kind: 'claude', configDir: null },
        { kind: 'claude', configDir: '/Users/me/.claude-work' },
      ]}
      login={LOGIN}
      nameOf={nameOf}
      profiles={[
        {
          id: 'work',
          name: 'Work account',
          agent: 'claude',
          dir: '/Users/me/.claude-work',
          color: 'blue',
        },
      ]}
    />
  ),
};

export const GeniroUpdateAvailable: Story = {
  render: () => (
    <AppUpdateCard update={appUpdate('available')} remote={false} />
  ),
};

export const GeniroUpdateReady: Story = {
  render: () => <AppUpdateCard update={appUpdate('ready')} remote={false} />,
};

export const GeniroUpdateOnPhone: Story = {
  render: () => <AppUpdateCard update={appUpdate('ready')} remote />,
};

export const SharesWaitingForSignIn: Story = {
  render: () => (
    <ShareSignInCard
      wait={{
        destinationId: 'gcs',
        label: 'Google Cloud',
        reason: 'Sign-in required (gcloud)',
        count: 3,
      }}
      api={{} as DaemonApis['shares']}
    />
  ),
};

export const MemoryConflicts: Story = {
  render: () => <MemoryConflictsCard count={4} onOpen={noop} />,
};
