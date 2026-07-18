import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC, type Settings } from '../shared/contracts';
import type { DaemonSupervisor } from './daemon-supervisor';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  const settings: Settings = {
    onboardingComplete: false,
    projectFolder: null,
    recentFolders: [],
    lastChatTarget: null,
    cliPaths: {},
    checkForUpdates: true,
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
    saveSecret: vi.fn(),
    deleteSecret: vi.fn(),
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
vi.mock('./keychain', () => ({
  deleteSecret: mocks.deleteSecret,
  hasSecret: vi.fn(() => false),
  saveSecret: mocks.saveSecret,
}));
vi.mock('./settings', () => ({
  readSettings: mocks.readSettings,
  updateSettings: mocks.updateSettings,
}));
vi.mock('./updater', () => ({ checkForUpdates: vi.fn() }));

import { registerIpc } from './ipc';

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel);
  if (!registered) {
    throw new Error(`missing handler ${channel}`);
  }
  return registered;
}

describe('registerIpc daemon configuration refresh', () => {
  const send = vi.fn();
  const event = { sender: { send } };
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

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registerIpc(supervisor);
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

  it('restarts after saving or deleting the Cursor secret', async () => {
    await handler(IPC.saveSecret)(event, 'cursor.apiKey', 'secret');
    expect(mocks.saveSecret).toHaveBeenCalledWith('cursor.apiKey', 'secret');
    expect(restart).toHaveBeenCalledOnce();

    restart.mockClear();
    await handler(IPC.deleteSecret)(event, 'cursor.apiKey');
    expect(mocks.deleteSecret).toHaveBeenCalledWith('cursor.apiKey');
    expect(restart).toHaveBeenCalledOnce();
  });

  it('restarts only after onboarding settings and Keychain writes complete', async () => {
    const result = await handler(IPC.completeOnboarding)(event, {
      cliPaths: { 'cursor-agent': '/opt/cursor-agent' },
      cursorApiKey: 'secret',
    });

    expect(mocks.saveSecret).toHaveBeenCalledWith('cursor.apiKey', 'secret');
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      onboardingComplete: true,
      cliPaths: { 'cursor-agent': '/opt/cursor-agent' },
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(mocks.saveSecret.mock.invocationCallOrder[0]).toBeLessThan(
      restart.mock.invocationCallOrder[0]!,
    );
    expect(mocks.updateSettings.mock.invocationCallOrder[0]).toBeLessThan(
      restart.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({ onboardingComplete: true });
  });
});
