import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC, type Settings } from '../shared/contracts';
import type { DaemonSupervisor } from './daemon-supervisor';
import type { UpdateService } from './update-service';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

// Same double shape as `ipc.spec.ts` — `registerIpc` has to run for real to
// produce a registry, so it needs the same environment that spec already
// built rather than a second one that could drift from it.
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  const settings: Settings = {
    onboardingComplete: false,
    projectFolder: null,
    recentFolders: [],
    configDir: null,
    recentConfigDirs: [],
    runConfigs: [],
    fastActions: [],
    configProfiles: [],
    lastChatTarget: null,
    lastApprovalMode: null,
    lastModels: {},
    lastEfforts: {},
    lastContextWindows: {},
    lastAutoCompactPercent: null,
    lastModelParameters: {},
    cliPaths: {},
    checkForUpdates: true,
    sidebarCollapsed: false,
    notificationsEnabled: true,
    archiveRetentionDays: null,
    cursorMaxMode: true,
    collapseToolSteps: false,
    daemonInspect: false,
    claudeBrowserTools: false,
    customInstructions: '',
    theme: 'system',
    remoteAccessEnabled: true,
  };
  return {
    handlers,
    settings,
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    readSettings: vi.fn((): Settings => settings),
    updateSettings: vi.fn((patch: Partial<Settings>): Settings => ({
      ...settings,
      ...patch,
    })),
  };
});

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  ipcMain: { handle: mocks.handle },
}));
vi.mock('./cli-detect', () => ({ detectClis: vi.fn(() => []) }));
vi.mock('./native-appearance', () => ({ applyTheme: vi.fn() }));
vi.mock('./settings', () => ({
  readSettings: mocks.readSettings,
  updateSettings: mocks.updateSettings,
}));

import { registerIpc } from './ipc';
import type { IpcRegistry } from './ipc-registry';
import type { TerminalSessions } from './terminal-sessions';

const noTerminals = {} as TerminalSessions;

// Every channel `preload/index.ts` answers with `ipcRenderer.on` rather than
// `ipcRenderer.invoke` — a push subscription, never a request `registerIpc`
// could route a reply to — follows this naming convention with no exception
// (verified against `IPC` below). Deriving the exclusion from the convention,
// rather than hand-listing the six, keeps the expectation built from `IPC`
// itself: a genuinely new invoke channel is still caught the moment it is
// added, and only a channel that opts into the "on…" convention is skipped.
const PUSH_CHANNEL_PATTERN = /^on[A-Z]/;

const invokeChannelKeys = Object.keys(IPC).filter(
  (key) => !PUSH_CHANNEL_PATTERN.test(key),
) as (keyof typeof IPC)[];

// The channels that act on the physical computer running geniro (a native
// dialog, the Finder, the in-app terminal, the app's own lifecycle) or whose
// handler reads the Electron `event` argument for identity/push-back — a
// remote HTTP call has no WebContents behind it, so neither shape can be
// served that way. Asserted by name per the task: this is the actual
// security-relevant fact under test, not a restatement of the registry.
const DENIED_CHANNEL_KEYS: (keyof typeof IPC)[] = [
  'getDaemonHandle',
  'pickProjectFolder',
  'pickAgentBinary',
  'pickTaskFiles',
  'pickWorkflowImport',
  'pickWorkflowExport',
  'saveChatExport',
  'saveArtifact',
  'openInTerminal',
  'revealPath',
  'openNotificationSettings',
  'toggleDevTools',
  'installUpdate',
  'relaunchForUpdate',
  'terminalCreate',
  'terminalWrite',
  'terminalResize',
  'terminalAck',
  'terminalKill',
  'notify',
  'testNotification',
  'completeOnboarding',
  'switchBranch',
  'pullBranch',
  // Not "acts on the desktop" in the WebContents sense the others are — these
  // change WHERE this machine is reachable from. Opening a public address is a
  // decision for somebody at the Mac, never for whoever holds a paired phone's
  // cookie, so a stolen phone cannot publish its owner's agents.
  'startRemoteTunnel',
  'stopRemoteTunnel',
];

describe('the registry registerIpc builds', () => {
  let registry: IpcRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    const supervisor = {
      getHandle: vi.fn(() => null),
      isConnected: vi.fn(() => false),
      restart: vi.fn(async () => ({
        host: '127.0.0.1',
        port: 4823,
        token: 'token',
        version: '1.0.0',
      })),
    } as unknown as DaemonSupervisor;
    const updates = {
      start: vi.fn(),
      getState: vi.fn(),
      check: vi.fn(),
      install: vi.fn(),
      relaunch: vi.fn(),
    } as unknown as UpdateService;
    registry = registerIpc(supervisor, updates, noTerminals);
  });

  it('registers every invoke channel from IPC exactly once', () => {
    const names = registry.channelNames();
    for (const key of invokeChannelKeys) {
      const channel = IPC[key];
      expect(names.filter((name) => name === channel)).toHaveLength(1);
    }
    // Bounds the registry to exactly that set — a handler recorded under a
    // misspelled or stray channel string would still pass the loop above.
    expect(names).toHaveLength(invokeChannelKeys.length);
  });

  it('denies exactly the channels that act on the desktop or need a WebContents, everything else allowed', () => {
    const denied = new Set<string>(DENIED_CHANNEL_KEYS.map((key) => IPC[key]));
    for (const key of invokeChannelKeys) {
      const entry = registry.get(IPC[key]);
      const expected = denied.has(IPC[key]) ? 'deny' : 'allow';
      expect(entry?.policy.remote).toBe(expected);
    }
  });

  it('gives every denied channel a non-empty reason', () => {
    for (const key of DENIED_CHANNEL_KEYS) {
      const entry = registry.get(IPC[key]);
      expect(entry?.policy.remote).toBe('deny');
      if (entry?.policy.remote === 'deny') {
        expect(entry.policy.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('does not resolve an unknown channel to a handler', () => {
    expect(registry.get('geniro:notARealChannel')).toBeUndefined();
  });
});
