import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC, type Settings } from '../shared/contracts';
import type { DaemonSupervisor } from './daemon-supervisor';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  // Spelled out rather than spread from DEFAULT_SETTINGS: this object is
  // built inside vi.hoisted(), which runs BEFORE module imports initialize —
  // referencing the import there throws at load.
  const settings: Settings = {
    onboardingComplete: false,
    projectFolder: null,
    recentFolders: [],
    configDir: null,
    recentConfigDirs: [],
    runConfigs: [],
    lastChatTarget: null,
    lastApprovalMode: null,
    lastModels: {},
    lastEfforts: {},
    cliPaths: {},
    checkForUpdates: true,
    sidebarCollapsed: false,
    notificationsEnabled: true,
    daemonInspect: false,
    claudeBrowserTools: false,
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
vi.mock('./settings', () => ({
  readSettings: mocks.readSettings,
  updateSettings: mocks.updateSettings,
}));

import { registerIpc } from './ipc';
import type { UpdateService } from './update-service';

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel);
  if (!registered) {
    throw new Error(`missing handler ${channel}`);
  }
  return registered;
}

describe('registerIpc daemon configuration refresh', () => {
  const send = vi.fn();
  const toggleDevTools = vi.fn();
  const event = { sender: { send, toggleDevTools } };
  const restart = vi.fn(async () => ({
    host: '127.0.0.1',
    port: 4823,
    token: 'token',
    version: '1.0.0',
  }));
  const supervisor = {
    getHandle: vi.fn(() => null),
    isConnected: vi.fn(() => false),
    restart,
  } as unknown as DaemonSupervisor;
  const updateStart = vi.fn();
  const updates = {
    start: updateStart,
    getState: vi.fn(),
    check: vi.fn(),
    install: vi.fn(),
  } as unknown as UpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registerIpc(supervisor, updates);
  });

  it('re-arms automatic update checks the moment the toggle is flipped', async () => {
    await handler(IPC.updateSettings)(event, { checkForUpdates: true });

    // Without this the switch only takes effect at the NEXT launch, so a user
    // who turns checking on is told nothing until they quit and reopen.
    expect(updateStart).toHaveBeenCalledWith(true);

    updateStart.mockClear();
    await handler(IPC.updateSettings)(event, { checkForUpdates: false });
    expect(updateStart).toHaveBeenCalledWith(false);

    // An unrelated setting must not restart the schedule — that would reset
    // the interval on every keystroke-debounced binary-path save.
    updateStart.mockClear();
    await handler(IPC.updateSettings)(event, { notificationsEnabled: false });
    expect(updateStart).not.toHaveBeenCalled();
  });

  it('restarts after CLI path settings change, but not unrelated settings', async () => {
    await handler(IPC.updateSettings)(event, {
      cliPaths: { claude: '/opt/claude' },
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      IPC.onDaemonRestarted,
      expect.objectContaining({ token: 'token' }),
    );

    restart.mockClear();
    await handler(IPC.updateSettings)(event, { checkForUpdates: false });
    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts after the daemon-inspector toggle, which only a new process can honour', async () => {
    await handler(IPC.updateSettings)(event, { daemonInspect: true });

    expect(mocks.updateSettings).toHaveBeenCalledWith({ daemonInspect: true });
    // Without the respawn the switch reads "on" while the running daemon has
    // no inspector — chrome://inspect finds nothing and the setting is a lie.
    expect(restart).toHaveBeenCalledOnce();

    restart.mockClear();
    await handler(IPC.updateSettings)(event, { daemonInspect: false });
    expect(restart).toHaveBeenCalledOnce();
  });

  it('toggles DevTools on the calling window only', async () => {
    await handler(IPC.toggleDevTools)(event);

    // The SENDER's own WebContents. Resolving a window some other way (a
    // focused-window lookup, an index) is what would let one window open
    // another's inspector.
    expect(toggleDevTools).toHaveBeenCalledOnce();
  });

  it('accepts the composer chips the renderer remembers, and still refuses an unknown key', async () => {
    // The patch schema is a strictObject, so a key it does not name is DROPPED
    // with a throw — a chip whose value silently never persists is exactly the
    // failure this pins. Neither vocabulary is enumerated here: both belong to
    // the CLIs.
    await handler(IPC.updateSettings)(event, {
      lastEfforts: { claude: 'ultracode' },
      lastModels: { claude: 'opus' },
    });
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      lastEfforts: { claude: 'ultracode' },
      lastModels: { claude: 'opus' },
    });
    expect(restart).not.toHaveBeenCalled();

    await expect(
      handler(IPC.updateSettings)(event, { notASetting: 'x' }),
    ).rejects.toThrow();
  });

  it('restarts only after onboarding settings are committed', async () => {
    const result = await handler(IPC.completeOnboarding)(event, {
      cliPaths: { 'cursor-agent': '/opt/cursor-agent' },
    });

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      onboardingComplete: true,
      cliPaths: { 'cursor-agent': '/opt/cursor-agent' },
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(mocks.updateSettings.mock.invocationCallOrder[0]).toBeLessThan(
      restart.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({ onboardingComplete: true });
  });
});
