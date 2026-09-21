import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC, type Settings } from '../shared/contracts';
import type { RemoteAccessState } from '../shared/remote';
import type { DaemonSupervisor } from './daemon-supervisor';
import type { RemoteAccess } from './remote/remote-access';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  // TWO windows, so "told the caller" and "told every window" are
  // distinguishable — with one open they look identical, which is exactly how
  // the caller-only send went unnoticed.
  const sendToWindow = vi.fn();
  const getAllWindows = vi.fn(() => [
    { webContents: { send: sendToWindow } },
    { webContents: { send: sendToWindow } },
  ]);
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
    remoteAccessEnabled: true,
    archiveRetentionDays: null,
    cursorMaxMode: true,
    collapseToolSteps: false,
    daemonInspect: false,
    claudeBrowserTools: false,
    customInstructions: '',
    theme: 'system',
  };
  return {
    handlers,
    settings,
    sendToWindow,
    getAllWindows,
    applyTheme: vi.fn(() => 'light' as const),
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
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
}));
vi.mock('./cli-detect', () => ({ detectClis: vi.fn(() => []) }));
vi.mock('./native-appearance', () => ({ applyTheme: mocks.applyTheme }));
vi.mock('./settings', () => ({
  readSettings: mocks.readSettings,
  updateSettings: mocks.updateSettings,
}));

import { registerIpc } from './ipc';
import type { TerminalSessions } from './terminal-sessions';
import type { UpdateService } from './update-service';

const noTerminals = {} as TerminalSessions;

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
    registerIpc(supervisor, updates, noTerminals);
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
    expect(mocks.sendToWindow).toHaveBeenCalledWith(
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

  it('applies a theme change to the OS at once, and does not respawn the daemon for it', async () => {
    await handler(IPC.updateSettings)(event, { theme: 'dark' });

    // Applied in MAIN, because this one write themes the OS chrome the app does
    // not paint AND — through `prefers-color-scheme` — the page itself. A
    // renderer that themed only itself would leave the traffic lights, the
    // context menu and the system dialogs on the other appearance. `applyTheme`
    // specifically: it also repaints the open window's own ground, which is a
    // construction option nothing else re-reads.
    expect(mocks.applyTheme).toHaveBeenCalledWith('dark');
    // Nothing about a theme rides the daemon's env or its launch flags, so a
    // respawn here would cost the user a running turn for a colour.
    expect(restart).not.toHaveBeenCalled();

    mocks.applyTheme.mockClear();
    await handler(IPC.updateSettings)(event, { notificationsEnabled: false });
    expect(mocks.applyTheme).not.toHaveBeenCalled();
  });

  it('refuses a theme the app does not ship', async () => {
    // ENUMERATED, unlike the CLI-vocabulary fields: a theme is a file this repo
    // ships, so a value outside the list names nothing that can be painted.
    await expect(
      handler(IPC.updateSettings)(event, { theme: 'solarized' }),
    ).rejects.toThrow();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
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

  // A restart mints a fresh port and token, so a window left holding the
  // previous handle is talking to a daemon that no longer exists. Announcing
  // it to `event.sender` alone told the caller and nobody else — and a remote
  // call over the LAN gateway has no sender at all.
  it('hands a restarted daemon handle to every window, not just the caller', async () => {
    await handler(IPC.completeOnboarding)(event, {
      cliPaths: { 'cursor-agent': '/opt/cursor-agent' },
    });

    expect(mocks.getAllWindows).toHaveBeenCalled();
    expect(mocks.sendToWindow).toHaveBeenCalledTimes(2);
    expect(mocks.sendToWindow).toHaveBeenNthCalledWith(
      1,
      IPC.onDaemonRestarted,
      expect.anything(),
    );
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

describe('registerIpc terminal channels', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const terminals = {
    create: vi.fn(async () => undefined),
    write: vi.fn(),
    resize: vi.fn(),
    ack: vi.fn(),
    kill: vi.fn(),
    disposeOwner: vi.fn(),
  };
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const mainFrame = { name: 'top' };
  const sender = {
    id: 7,
    mainFrame,
    once: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    }),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    }),
  };
  const event = { sender, senderFrame: mainFrame };
  const fromSubframe = { sender, senderFrame: { name: 'iframe' } };
  const fire = (name: string, ...args: unknown[]): void =>
    (listeners.get(name) ?? []).forEach((listener) => listener(...args));

  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    mocks.handlers.clear();
    registerIpc(
      {} as DaemonSupervisor,
      {} as UpdateService,
      terminals as unknown as TerminalSessions,
    );
  });

  it('starts a shell for the SENDER, validated, and watches that window once', async () => {
    const input = { id: ID, cwd: '/proj', cols: 80, rows: 24 };
    await handler(IPC.terminalCreate)(event, input);
    await handler(IPC.terminalCreate)(event, {
      ...input,
      id: crypto.randomUUID(),
    });

    expect(terminals.create).toHaveBeenCalledWith(sender, input);
    expect(listeners.get('destroyed')).toHaveLength(1);
    expect(listeners.get('did-navigate')).toHaveLength(1);
  });

  it('refuses a relative folder, an unknown key and a malformed id before anything spawns', () => {
    expect(() =>
      handler(IPC.terminalCreate)(event, {
        id: ID,
        cwd: 'proj',
        cols: 80,
        rows: 24,
      }),
    ).toThrow();
    expect(() =>
      handler(IPC.terminalCreate)(event, {
        id: ID,
        cols: 80,
        rows: 24,
        shell: '/bin/evil',
      }),
    ).toThrow();
    expect(() => handler(IPC.terminalWrite)(event, '../x', 'ls\r')).toThrow();
    expect(terminals.create).not.toHaveBeenCalled();
    expect(terminals.write).not.toHaveBeenCalled();
  });

  it('answers the top-level page only, never a subframe', () => {
    expect(() =>
      handler(IPC.terminalCreate)(fromSubframe, { id: ID, cols: 80, rows: 24 }),
    ).toThrow(/top-level page/);
    expect(() => handler(IPC.terminalWrite)(fromSubframe, ID, 'ls\r')).toThrow(
      /top-level page/,
    );
    expect(() => handler(IPC.terminalResize)(fromSubframe, ID, 80, 24)).toThrow(
      /top-level page/,
    );
    expect(() => handler(IPC.terminalKill)(fromSubframe, ID)).toThrow(
      /top-level page/,
    );
    expect(() => handler(IPC.terminalAck)(fromSubframe, ID, 10)).toThrow(
      /top-level page/,
    );
    expect(terminals.ack).not.toHaveBeenCalled();
    expect(terminals.create).not.toHaveBeenCalled();
    expect(terminals.write).not.toHaveBeenCalled();
    expect(terminals.resize).not.toHaveBeenCalled();
    expect(terminals.kill).not.toHaveBeenCalled();
  });

  it('routes keystrokes, sizes and kills to the sender’s own shells', async () => {
    await handler(IPC.terminalWrite)(event, ID, 'ls\r');
    await handler(IPC.terminalResize)(event, ID, 120, 40);
    await handler(IPC.terminalKill)(event, ID);
    await handler(IPC.terminalAck)(event, ID, 42);
    expect(() => handler(IPC.terminalAck)(event, ID, -1)).toThrow();

    expect(terminals.write).toHaveBeenCalledWith(sender, ID, 'ls\r');
    expect(terminals.resize).toHaveBeenCalledWith(sender, ID, 120, 40);
    expect(terminals.kill).toHaveBeenCalledWith(sender, ID);
    expect(terminals.ack.mock.calls).toEqual([[sender, ID, 42]]);
  });

  it('ends a window’s shells on close, crash and a COMMITTED navigation — never on one that was only started', async () => {
    await handler(IPC.terminalCreate)(event, { id: ID, cols: 80, rows: 24 });

    // A navigation `will-navigate` goes on to block still fires this one.
    fire('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(terminals.disposeOwner).not.toHaveBeenCalled();

    fire('did-navigate');
    fire('render-process-gone');
    fire('destroyed');
    expect(terminals.disposeOwner.mock.calls).toEqual([[7], [7], [7]]);
  });
});

describe('registerIpc remote-access channels', () => {
  // Annotated, and carrying a real device: with `devices: []` the entries are
  // inferred `never` (which is a type error the moment a field is read) and
  // the redaction loop below runs zero times — so the tokenHash pin would
  // have passed against any redactor at all, including one that blanked
  // nothing.
  const rawState: RemoteAccessState = {
    enabled: true,
    listening: true,
    port: 47616,
    hostUrl: 'http://geniro-mac.local:47616',
    addressUrl: 'http://192.168.1.42:47616',
    pairingCode: '482917',
    pairingCodeExpiresAt: '2026-09-21T12:30:00.000Z',
    devices: [
      {
        id: 'device-1',
        tokenHash: 'a'.repeat(64),
        label: 'iPhone',
        pairedAt: '2026-09-21T12:00:00.000Z',
        lastSeenAt: '2026-09-21T12:25:00.000Z',
      },
      {
        id: 'device-2',
        tokenHash: 'b'.repeat(64),
        label: 'iPad',
        pairedAt: '2026-09-20T09:00:00.000Z',
        lastSeenAt: '2026-09-21T11:00:00.000Z',
      },
    ],
    unavailableReason: null,
  };
  const remoteAccess = {
    state: vi.fn(() => rawState),
    regenerateCode: vi.fn(() => rawState),
    revokeDevice: vi.fn(() => rawState),
  };
  let registry: ReturnType<typeof registerIpc>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registry = registerIpc(
      {} as DaemonSupervisor,
      {} as UpdateService,
      noTerminals,
      () => remoteAccess as unknown as RemoteAccess,
    );
  });

  // The DESKTOP call — through the plain handler, as `ipc.ts` itself invokes
  // it — must keep both fields; only the REMOTE bridge redacts them.
  it('the handler itself answers the pairing code in full (the desktop path)', async () => {
    expect(await handler(IPC.getRemoteAccess)({})).toEqual(rawState);
    expect(await handler(IPC.regenerateRemotePairingCode)({})).toEqual(
      rawState,
    );
    expect(
      await handler(IPC.revokeRemoteDevice)(
        {},
        '11111111-1111-4111-8111-111111111111',
      ),
    ).toEqual(rawState);
  });

  // A paired phone polling `getRemoteAccess` (or calling the other two) must
  // never learn the live pairing code — otherwise it can hand the code to
  // another device and enrol it without ever touching the Mac. This is what
  // the LAN gateway's bridge applies before a remote reply leaves the
  // process; see `remote-routes.ts`'s `bridge()`.
  it('blanks pairingCode/pairingCodeExpiresAt for all three channels, over the remote policy', () => {
    for (const channel of [
      IPC.getRemoteAccess,
      IPC.regenerateRemotePairingCode,
      IPC.revokeRemoteDevice,
    ]) {
      const entry = registry.get(channel);
      if (
        !entry ||
        entry.policy.remote !== 'allow' ||
        !entry.policy.redactForRemote
      ) {
        throw new Error(`${channel} carries no redactForRemote`);
      }
      const redacted = entry.policy.redactForRemote(
        rawState,
      ) as typeof rawState;
      expect(redacted.pairingCode).toBeNull();
      expect(redacted.pairingCodeExpiresAt).toBeNull();
      // The device LIST still crosses — a paired caller is meant to see which
      // devices are enrolled — but each `tokenHash` is blanked: it is a
      // credential digest, nothing renders it, and it buys a remote reader
      // nothing the rest of the row does not already say.
      expect(redacted.devices).toHaveLength(rawState.devices.length);
      for (const [index, device] of redacted.devices.entries()) {
        const raw = rawState.devices[index]!;
        expect(device.tokenHash).toBe('');
        expect(device.id).toBe(raw.id);
        expect(device.label).toBe(raw.label);
        expect(device.pairedAt).toBe(raw.pairedAt);
        expect(device.lastSeenAt).toBe(raw.lastSeenAt);
      }
      // And nothing else about the state is withheld.
      expect(redacted.hostUrl).toBe(rawState.hostUrl);
    }
  });
});
