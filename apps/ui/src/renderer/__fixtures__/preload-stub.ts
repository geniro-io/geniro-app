import {
  type BranchPullResult,
  type BranchSwitchResult,
  type ChatExportSaveResult,
  CLI_KINDS,
  type CliDetection,
  type CliUpdateResult,
  type DaemonHandle,
  DEFAULT_SETTINGS,
  type GeniroApi,
  type GitInfo,
  type PullRequestRefResult,
  type PullRequestsResult,
  type Settings,
  type UpdateState,
} from '../../shared/contracts';

/**
 * A `window.geniro` that answers without Electron.
 *
 * Typed as {@link GeniroApi} rather than cast to it, which is the point: a
 * channel added to that interface stops this file compiling, so the catalog
 * cannot silently fall behind the preload bridge it is standing in for.
 *
 * Every answer here is a plausible EMPTY state — no folder chosen, no CLI
 * detected, no pull requests — so a caller sees a zero state rather than
 * fabricated data it might mistake for real behaviour.
 *
 * ONE double for the whole app: the Storybook catalog installs it whole, and a
 * spec passes `overrides` for the handful of channels it actually asserts on.
 * Before this existed each spec built its own bag of spies and reached the
 * bridge through `as unknown as Partial<GeniroApi>` — a double cast that
 * defeats exactly the guarantee the type here provides, so a channel added to
 * the interface broke nothing and every spec kept passing against a bridge that
 * no longer matched.
 *
 * Lives under `src/` rather than beside the Storybook config precisely so the
 * specs can reach it; nothing in production code imports it.
 */

const warned = new Set<string>();

/** Names the channel a story reached for, once, so the log stays readable. */
function note(channel: string): void {
  if (warned.has(channel)) {
    return;
  }
  warned.add(channel);
  console.info(`[storybook] window.geniro.${channel}() — stub answered`);
}

/** Subscriptions hand back a no-op unsubscribe; nothing ever pushes here. */
function noSubscription(channel: string): () => void {
  note(channel);
  return () => undefined;
}

const IDLE_UPDATE: UpdateState = {
  phase: 'idle',
  version: null,
  progress: null,
  message: null,
  failedPhase: null,
  currentVersion: '0.0.0-storybook',
  canInstall: false,
};

const NO_GIT: GitInfo = {
  isRepo: false,
  branch: null,
  branches: [],
  dirty: false,
  worktrees: [],
};

const NO_PULL_REQUESTS: PullRequestsResult = {
  branch: null,
  originOwner: null,
  pullRequests: [],
};

export function createPreloadStub(
  overrides: Partial<GeniroApi> = {},
): GeniroApi {
  // Settings are the one piece of state the stub keeps: `useSidebarCollapsed`
  // writes then re-reads, and a stub that forgot would make the rail's toggle
  // appear not to work.
  let settings: Settings = { ...DEFAULT_SETTINGS, onboardingComplete: true };

  return {
    getStatus: () => {
      note('getStatus');
      return Promise.resolve({
        onboardingComplete: settings.onboardingComplete,
        daemon: { connected: false, handle: null },
        isPackaged: false,
      });
    },
    getDaemonHandle: (): Promise<DaemonHandle | null> => {
      note('getDaemonHandle');
      return Promise.resolve(null);
    },
    onDaemonRestarted: () => noSubscription('onDaemonRestarted'),
    onClearAgentCaches: () => noSubscription('onClearAgentCaches'),

    pickProjectFolder: () => {
      note('pickProjectFolder');
      return Promise.resolve(null);
    },
    pickAgentBinary: () => {
      note('pickAgentBinary');
      return Promise.resolve(null);
    },
    pickWorkflowImport: () => {
      note('pickWorkflowImport');
      return Promise.resolve(null);
    },
    pickWorkflowExport: () => {
      note('pickWorkflowExport');
      return Promise.resolve(null);
    },

    getSettings: () => {
      note('getSettings');
      return Promise.resolve(settings);
    },
    updateSettings: (patch: Partial<Settings>) => {
      note('updateSettings');
      settings = { ...settings, ...patch };
      return Promise.resolve(settings);
    },
    completeOnboarding: () => {
      note('completeOnboarding');
      settings = { ...settings, onboardingComplete: true };
      return Promise.resolve(settings);
    },

    detectClis: (): Promise<CliDetection[]> => {
      note('detectClis');
      return Promise.resolve(
        CLI_KINDS.map((kind) => ({
          kind,
          found: false,
          path: null,
          version: null,
          loggedIn: null,
          update: {
            available: null,
            latestVersion: null,
            checkUnavailableReason: null,
          },
        })),
      );
    },

    updateCli: (kind): Promise<CliUpdateResult> => {
      note('updateCli');
      // The zero answer for a CLI this stub has already said is not installed —
      // populated outcomes come through props, like everything else here.
      return Promise.resolve({
        kind,
        ok: false,
        previousVersion: null,
        version: null,
        output: null,
      });
    },

    getUpdateState: () => {
      note('getUpdateState');
      return Promise.resolve(IDLE_UPDATE);
    },
    checkForUpdates: () => {
      note('checkForUpdates');
      return Promise.resolve(IDLE_UPDATE);
    },
    installUpdate: () => {
      note('installUpdate');
      return Promise.resolve(IDLE_UPDATE);
    },
    relaunchForUpdate: () => {
      note('relaunchForUpdate');
      return Promise.resolve(IDLE_UPDATE);
    },
    onUpdateState: () => noSubscription('onUpdateState'),

    getGitInfo: () => {
      note('getGitInfo');
      return Promise.resolve(NO_GIT);
    },
    switchBranch: (
      _dir: string,
      branch: string,
    ): Promise<BranchSwitchResult> => {
      note('switchBranch');
      return Promise.resolve({
        ok: true,
        branch,
        error: null,
        dirty: false,
        worktree: null,
      });
    },
    pullBranch: (): Promise<BranchPullResult> => {
      note('pullBranch');
      return Promise.resolve({
        ok: true,
        branch: null,
        error: null,
        stashLeft: null,
      });
    },
    getPullRequests: () => {
      note('getPullRequests');
      return Promise.resolve(NO_PULL_REQUESTS);
    },
    getPullRequestsByRef: (refs): Promise<PullRequestRefResult[]> => {
      note('getPullRequestsByRef');
      // The ref always comes back with a null state — the same shape a
      // logged-out `gh` produces, rather than dropping the row.
      return Promise.resolve(refs.map((ref) => ({ ref, pullRequest: null })));
    },

    openInTerminal: () => {
      note('openInTerminal');
      return Promise.resolve();
    },
    openTerminalAt: () => {
      note('openTerminalAt');
      return Promise.resolve();
    },
    saveChatExport: (): Promise<ChatExportSaveResult> => {
      note('saveChatExport');
      // The cancel outcome: nothing here can write a file.
      return Promise.resolve({ saved: false, path: null });
    },
    revealPath: () => {
      note('revealPath');
      return Promise.resolve({
        revealed: false,
        reason: 'Storybook has no file manager to reveal in.',
      });
    },
    toggleDevTools: () => {
      note('toggleDevTools');
      return Promise.resolve();
    },

    notify: () => {
      note('notify');
      return Promise.resolve();
    },
    testNotification: () => {
      note('testNotification');
      return Promise.resolve({
        posted: false,
        shown: null,
        reason: 'Storybook cannot post a system notification.',
      });
    },
    openNotificationSettings: () => {
      note('openNotificationSettings');
      return Promise.resolve();
    },
    onNotificationActivated: () => noSubscription('onNotificationActivated'),

    filePath: () => {
      note('filePath');
      return null;
    },
    ...overrides,
  };
}
