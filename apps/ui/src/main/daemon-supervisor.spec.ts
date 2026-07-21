import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '../shared/contracts';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/geniro-supervisor-spec'),
    getAppPath: vi.fn(() => '/tmp/geniro-supervisor-spec/app'),
  },
  getSecret: vi.fn((): string | null => null),
  loginShellPath: vi.fn(async () => null),
  readSettings: vi.fn((): Settings => ({
    onboardingComplete: true,
    projectFolder: null,
    recentFolders: [],
    lastChatTarget: null,
    cliPaths: { claude: '/opt/tools/claude' },
    checkForUpdates: true,
  })),
}));

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('./keychain', () => ({ getSecret: mocks.getSecret }));
vi.mock('./login-shell-path', () => ({
  loginShellPath: mocks.loginShellPath,
}));
vi.mock('./settings', () => ({ readSettings: mocks.readSettings }));

import type { DaemonInfo } from './daemon-pidfile';
import {
  DaemonSupervisor,
  type DaemonSupervisorOptions,
  defaultCheckHealth,
  defaultCheckIdentity,
} from './daemon-supervisor';

class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }
}

function info(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    pid: 1111,
    host: '127.0.0.1',
    port: 4823,
    token: 'tok',
    version: '0.1.0',
    startedAt: '2026-07-04T00:00:00Z',
    ...overrides,
  };
}

interface Harness {
  supervisor: DaemonSupervisor;
  child: FakeChild;
  spawned: { env?: NodeJS.ProcessEnv }[];
  kills: { pid: number; signal: NodeJS.Signals }[];
  removed: string[];
  setPidfile(next: DaemonInfo | null): void;
}

function harness(opts: {
  pidfile: DaemonInfo | null;
  alive?: (pid: number) => boolean;
  /** May return a Promise so a test can park the supervisor mid-health-poll. */
  healthy?:
    boolean | ((current: DaemonInfo | null) => boolean | Promise<boolean>);
  identified?: boolean;
  bundled?: string | null;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  onKill?: (pid: number, signal: NodeJS.Signals) => void;
  graceMs?: number;
  pollMs?: number;
}): Harness {
  let pidfile = opts.pidfile;
  const child = new FakeChild();
  const spawned: { env?: NodeJS.ProcessEnv }[] = [];
  const kills: { pid: number; signal: NodeJS.Signals }[] = [];
  const killedPids = new Set<number>();
  const removed: string[] = [];
  const options: DaemonSupervisorOptions = {
    spawn: ((cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv }) => {
      void cmd;
      void args;
      spawned.push(o);
      // The spawned daemon "writes" its pidfile with the child's own pid.
      pidfile = info({ pid: child.pid, version: '0.2.0' });
      return child;
    }) as unknown as DaemonSupervisorOptions['spawn'],
    readDaemonInfo: () => pidfile,
    isAlive: opts.alive ?? ((pid) => !killedPids.has(pid)),
    checkHealth: async () =>
      typeof opts.healthy === 'function'
        ? opts.healthy(pidfile)
        : (opts.healthy ?? true),
    checkIdentity: async () => opts.identified ?? true,
    killPid:
      opts.killPid ??
      ((pid, signal) => {
        kills.push({ pid, signal });
        if (signal === 'SIGKILL') {
          killedPids.add(pid);
        }
        opts.onKill?.(pid, signal);
      }),
    resolveEntry: () => '/bundle/daemon/dist/main.js',
    bundledVersion: () => (opts.bundled === undefined ? '0.2.0' : opts.bundled),
    removePidfile: (path) => removed.push(path),
    pollIntervalMs: opts.pollMs ?? 1,
    shutdownGraceMs: opts.graceMs ?? 15,
  };
  return {
    supervisor: new DaemonSupervisor(options),
    child,
    spawned,
    kills,
    removed,
    setPidfile: (next) => {
      pidfile = next;
    },
  };
}

beforeEach(() => {
  mocks.getSecret.mockReturnValue(null);
  mocks.readSettings.mockReturnValue({
    onboardingComplete: true,
    projectFolder: null,
    recentFolders: [],
    lastChatTarget: null,
    cliPaths: { claude: '/opt/tools/claude' },
    checkForUpdates: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('defaultCheckHealth', () => {
  it('accepts only the expected Geniro health response shape', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      // The real wire shape: @packages/http-server's HealthStatus.Ok ('Ok').
      json: async () => ({ status: 'Ok', version: '1.0.0' }),
    });
    await expect(defaultCheckHealth('127.0.0.1', 4823)).resolves.toBe(true);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ service: 'not-geniro' }),
    });
    await expect(defaultCheckHealth('127.0.0.1', 4823)).resolves.toBe(false);

    // A case drift ('ok' vs the enum's 'Ok') must be rejected — this exact
    // mismatch shipped once and made every daemon spawn time out as unhealthy.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok', version: '1.0.0' }),
    });
    await expect(defaultCheckHealth('127.0.0.1', 4823)).resolves.toBe(false);
  });

  it('proves daemon identity with the launch bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      defaultCheckIdentity({
        host: '127.0.0.1',
        port: 4823,
        token: 'secret-token',
        version: '1.0.0',
      }),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4823/v1/chats',
      expect.objectContaining({
        headers: { authorization: 'Bearer secret-token' },
      }),
    );
  });
});

describe('DaemonSupervisor.start', () => {
  it('reuses a healthy daemon whose version matches the bundled daemon', async () => {
    const h = harness({ pidfile: info({ version: '0.2.0' }) });

    const handle = await h.supervisor.start();

    expect(handle.port).toBe(4823);
    expect(h.spawned).toHaveLength(0);
    expect(h.kills).toHaveLength(0);
    // Adopted, not owned: stop() must leave the shared daemon running.
    await h.supervisor.stop();
    expect(h.child.signals).toHaveLength(0);
  });

  it('kills and respawns a healthy daemon left over from another version', async () => {
    // Fake timers so the SIGTERM→exit window is deterministic (no wall-clock
    // race — testing.md bans nondeterminism).
    vi.useFakeTimers();
    try {
      let alive = true;
      const h = harness({
        pidfile: info({ pid: 1111, version: '0.1.0' }),
        alive: () => alive,
        graceMs: 50,
      });
      // The stale daemon exits promptly on SIGTERM, inside the grace window.
      setTimeout(() => {
        alive = false;
      }, 5);

      const started = h.supervisor.start();
      await vi.advanceTimersByTimeAsync(20);
      const handle = await started;

      expect(h.kills).toEqual([{ pid: 1111, signal: 'SIGTERM' }]);
      expect(h.removed).toHaveLength(1);
      expect(h.spawned).toHaveLength(1);
      expect(handle.version).toBe('0.2.0');
    } finally {
      vi.useRealTimers();
    }
  });

  it('escalates a stale-version daemon that ignores SIGTERM to SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      let staleAlive = true;
      const h = harness({
        pidfile: info({ pid: 1111, version: '0.1.0' }),
        alive: (pid) => (pid === 1111 ? staleAlive : true),
        onKill: (_pid, signal) => {
          if (signal === 'SIGKILL') {
            staleAlive = false;
          }
        },
        graceMs: 50,
      });

      const started = h.supervisor.start();
      await vi.advanceTimersByTimeAsync(1_100);
      await started;

      expect(h.kills).toEqual([
        { pid: 1111, signal: 'SIGTERM' },
        { pid: 1111, signal: 'SIGKILL' },
      ]);
      expect(h.spawned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spawn a replacement while the stale daemon remains alive after SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        pidfile: info({ pid: 1111, version: '0.1.0' }),
        alive: (pid) => pid === 1111,
        graceMs: 50,
        pollMs: 5,
      });

      const started = h.supervisor.start();
      await vi.advanceTimersByTimeAsync(1_200);

      await expect(started).rejects.toThrow(/remained alive|SIGKILL/i);
      expect(h.spawned).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the version gate when the bundled version is unreadable', async () => {
    const h = harness({ pidfile: info({ version: '0.1.0' }), bundled: null });

    const handle = await h.supervisor.start();

    expect(handle.version).toBe('0.1.0');
    expect(h.spawned).toHaveLength(0);
    expect(h.kills).toHaveLength(0);
  });

  it('sweeps a dead daemon pidfile and spawns fresh without signalling the corpse', async () => {
    const h = harness({
      pidfile: info({ pid: 1111 }),
      alive: (pid) => pid !== 1111,
    });

    const handle = await h.supervisor.start();

    expect(h.kills).toHaveLength(0);
    expect(h.removed).toHaveLength(1);
    expect(h.spawned).toHaveLength(1);
    expect(handle.version).toBe('0.2.0');
  });

  it('fails closed for an alive unhealthy pid instead of signalling or duplicating it', async () => {
    const h = harness({
      pidfile: info({ pid: 1111 }),
      alive: () => true,
      healthy: false,
    });

    await expect(h.supervisor.start()).rejects.toThrow(
      /failed identity\/health verification/,
    );

    expect(h.kills).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);
  });

  it('fails closed when an alive stale-version daemon cannot be signalled', async () => {
    const h = harness({
      pidfile: info({ pid: 1111, version: '0.1.0' }),
      alive: () => true,
      killPid: () => {
        const error = new Error(
          'operation not permitted',
        ) as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      },
    });

    await expect(h.supervisor.start()).rejects.toThrow(
      /operation not permitted|signal|refus/i,
    );

    expect(h.removed).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);
  });

  it('passes the Settings cliPaths override into the daemon spawn env', async () => {
    const h = harness({ pidfile: null });

    await h.supervisor.start();

    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.env?.GENIRO_CLAUDE_BIN).toBe('/opt/tools/claude');
    expect(h.spawned[0]?.env?.GENIRO_CURSOR_BIN).toBeUndefined();
  });

  it('terminates a spawned child that never becomes healthy before the startup deadline', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        pidfile: null,
        healthy: false,
        graceMs: 50,
        pollMs: 5_000,
      });

      const started = h.supervisor.start();
      const rejected = expect(started).rejects.toThrow(
        /did not become healthy/,
      );
      await vi.advanceTimersByTimeAsync(25_000);
      await rejected;

      expect(h.child.signals[0]).toBe('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent start() calls into one spawn and one shared handle', async () => {
    const h = harness({ pidfile: null });

    const first = h.supervisor.start();
    const second = h.supervisor.start();

    // The second caller joins the in-flight promise — it must never re-run the
    // pidfile check while the first spawn is mid-flight (two daemons would
    // otherwise both pass it and both spawn).
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    expect(a.port).toBe(4823);
    expect(h.spawned).toHaveLength(1);
  });
});

describe('DaemonSupervisor.restart', () => {
  it('replaces an adopted daemon and reloads Keychain and CLI settings', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        pidfile: info({ pid: 1111, version: '0.2.0' }),
        graceMs: 25,
      });
      await h.supervisor.start();
      mocks.getSecret.mockReturnValue('new-cursor-key');
      mocks.readSettings.mockReturnValue({
        onboardingComplete: true,
        projectFolder: null,
        recentFolders: [],
        lastChatTarget: null,
        cliPaths: { 'cursor-agent': '/opt/tools/cursor-agent' },
        checkForUpdates: true,
      });

      const restarted = h.supervisor.restart();
      await vi.advanceTimersByTimeAsync(50);
      await restarted;

      expect(h.kills).toEqual([
        { pid: 1111, signal: 'SIGTERM' },
        { pid: 1111, signal: 'SIGKILL' },
      ]);
      expect(h.spawned).toHaveLength(1);
      expect(h.spawned[0]?.env?.GENIRO_CURSOR_API_KEY).toBe('new-cursor-key');
      expect(h.spawned[0]?.env?.GENIRO_CURSOR_BIN).toBe(
        '/opt/tools/cursor-agent',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('supersedes a mid-flight restart: the overlapping restart() joins the same promise and the surviving daemon is spawned from the later settings', async () => {
    vi.useFakeTimers();
    try {
      const dead = new Set<number>();
      // One-shot gate on the first replacement daemon's health poll — the
      // deterministic interposition point "restart #1 has already spawned,
      // but its restartNow has not yet returned to the generation check".
      let releaseFirstHealth!: (healthy: boolean) => void;
      let firstHealthGate: Promise<boolean> | null = new Promise((resolve) => {
        releaseFirstHealth = resolve;
      });
      const h = harness({
        pidfile: info({ pid: 1111, version: '0.2.0' }),
        alive: (pid) => !dead.has(pid),
        healthy: (current) => {
          if (current?.pid === 4242 && firstHealthGate) {
            const gate = firstHealthGate;
            firstHealthGate = null;
            return gate;
          }
          return true;
        },
        // Every daemon in this scenario exits promptly on SIGTERM.
        onKill: (pid, signal) => {
          if (signal === 'SIGTERM') {
            dead.add(pid);
          }
        },
        graceMs: 500,
        pollMs: 5,
      });
      await h.supervisor.start(); // adopt the running same-version daemon
      expect(h.spawned).toHaveLength(0);

      const first = h.supervisor.restart();
      await vi.advanceTimersByTimeAsync(0);
      // Restart #1 terminated the adopted daemon and spawned a replacement
      // from the settings AS THEY WERE, and is now parked on the gate.
      expect(h.spawned).toHaveLength(1);
      expect(h.spawned[0]?.env?.GENIRO_CLAUDE_BIN).toBe('/opt/tools/claude');

      mocks.readSettings.mockReturnValue({
        onboardingComplete: true,
        projectFolder: null,
        recentFolders: [],
        lastChatTarget: null,
        cliPaths: { claude: '/opt/tools/claude-superseding' },
        checkForUpdates: true,
      });
      const second = h.supervisor.restart();
      // Coalesced: the overlapping restart shares the in-flight promise.
      expect(second).toBe(first);

      releaseFirstHealth(true);
      const finalHandle = await first;

      // The generation bumped mid-flight, so the loop went around once more:
      // the first replacement was itself terminated and the SURVIVING daemon
      // was spawned from the settings as of AFTER the second restart() call.
      expect(h.spawned).toHaveLength(2);
      expect(h.spawned[1]?.env?.GENIRO_CLAUDE_BIN).toBe(
        '/opt/tools/claude-superseding',
      );
      expect(h.kills).toEqual([
        { pid: 1111, signal: 'SIGTERM' },
        { pid: 4242, signal: 'SIGTERM' },
      ]);
      expect(h.supervisor.getHandle()).toBe(finalHandle);
      await expect(second).resolves.toBe(finalHandle);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DaemonSupervisor.stop', () => {
  it('SIGTERMs the owned child and escalates to SIGKILL when it will not exit', async () => {
    const h = harness({ pidfile: null, graceMs: 50 });
    await h.supervisor.start();

    vi.useFakeTimers();
    try {
      const stopped = h.supervisor.stop();
      await vi.advanceTimersByTimeAsync(100); // past the grace, child never exits
      await stopped;
    } finally {
      vi.useRealTimers();
    }

    expect(h.child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('lets the grace win when the child exits in time', async () => {
    const h = harness({ pidfile: null, graceMs: 50 });
    await h.supervisor.start();

    vi.useFakeTimers();
    try {
      const stopped = h.supervisor.stop();
      // Child exits well inside the grace — the exit race resolves first.
      h.child.exitCode = 0;
      h.child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(100);
      await stopped;
    } finally {
      vi.useRealTimers();
    }

    expect(h.child.signals).toEqual(['SIGTERM']);
  });

  it('interrupting a pending start(): the start rejects, stop() resolves, and the half-started child is killed', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        pidfile: null,
        healthy: false,
        graceMs: 50,
        pollMs: 5,
      });

      const started = h.supervisor.start();
      const rejected = expect(started).rejects.toThrow(
        /stopped during daemon startup/,
      );
      // The spawn already happened; the health poll is now in flight.
      expect(h.spawned).toHaveLength(1);

      const stopped = h.supervisor.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
      await stopped;

      expect(h.child.signals[0]).toBe('SIGTERM');
      // The FakeChild never exits, so the grace escalates to SIGKILL.
      expect(h.child.signals).toContain('SIGKILL');
      expect(h.supervisor.getHandle()).toBeNull();
      expect(h.supervisor.isConnected()).toBe(false);

      // Once stopping, new start() calls fail fast instead of respawning.
      await expect(h.supervisor.start()).rejects.toThrow(/is stopping/);
    } finally {
      vi.useRealTimers();
    }
  });
});
