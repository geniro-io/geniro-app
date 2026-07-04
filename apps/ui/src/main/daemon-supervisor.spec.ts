import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/geniro-supervisor-spec'),
    getAppPath: vi.fn(() => '/tmp/geniro-supervisor-spec/app'),
  },
  getSecret: vi.fn((): string | null => null),
  loginShellPath: vi.fn(async () => null),
  readSettings: vi.fn(() => ({
    onboardingComplete: true,
    projectFolder: null,
    defaultModel: null,
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
  healthy?: boolean;
  bundled?: string | null;
  graceMs?: number;
}): Harness {
  let pidfile = opts.pidfile;
  const child = new FakeChild();
  const spawned: { env?: NodeJS.ProcessEnv }[] = [];
  const kills: { pid: number; signal: NodeJS.Signals }[] = [];
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
    isAlive: opts.alive ?? (() => true),
    checkHealth: async () => opts.healthy ?? true,
    killPid: (pid, signal) => kills.push({ pid, signal }),
    resolveEntry: () => '/bundle/daemon/dist/main.js',
    bundledVersion: () => (opts.bundled === undefined ? '0.2.0' : opts.bundled),
    removePidfile: (path) => removed.push(path),
    pollIntervalMs: 1,
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
      const h = harness({
        pidfile: info({ pid: 1111, version: '0.1.0' }),
        alive: (pid) => pid === 1111, // never dies politely; new child adopts fine
        graceMs: 50,
      });

      const started = h.supervisor.start();
      await vi.advanceTimersByTimeAsync(100);
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

  it('passes the Settings cliPaths override into the daemon spawn env', async () => {
    const h = harness({ pidfile: null });

    await h.supervisor.start();

    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.env?.GENIRO_CLAUDE_BIN).toBe('/opt/tools/claude');
    expect(h.spawned[0]?.env?.GENIRO_CURSOR_BIN).toBeUndefined();
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
});
