import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '../shared/contracts';
import { DAEMON_INSPECT_PORT, DEFAULT_SETTINGS } from '../shared/contracts';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/geniro-supervisor-spec'),
    getAppPath: vi.fn(() => '/tmp/geniro-supervisor-spec/app'),
  },
  loginShellPath: vi.fn(async () => null),
  readSettings: vi.fn((): Settings => ({
    // Spread the real defaults: only cliPaths matters to these specs, and
    // restating every field turns each new Settings key into a spec edit.
    ...DEFAULT_SETTINGS,
    onboardingComplete: true,
    cliPaths: { claude: '/opt/tools/claude' },
  })),
}));

vi.mock('electron', () => ({ app: mocks.app }));
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
  constructor(readonly pid = 4242) {
    super();
  }
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
    // The entry `make()` below resolves to. It does not exist on disk, so the
    // supervisor cannot stat its own copy and falls back to the version gate —
    // which is what every test in this file is about. A NULL stamp would not do
    // that: it means "older than the staleness check" and is replaced.
    entry: { path: '/bundle/daemon/dist/main.js', mtimeMs: 1, size: 2 },
    pidStartedAtMs: null,
    startedAt: '2026-07-04T00:00:00Z',
    ...overrides,
  };
}

interface Harness {
  supervisor: DaemonSupervisor;
  child: FakeChild;
  spawned: { env?: NodeJS.ProcessEnv; args: string[] }[];
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
  /** Whether the running daemon reports work in flight. Idle unless a test says. */
  busy?: boolean;
  bundled?: string | null;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  onKill?: (pid: number, signal: NodeJS.Signals) => void;
  graceMs?: number;
  pollMs?: number;
  /** The kernel's start time for a pid — `ps`, unless a test says. */
  startTime?: (pid: number) => number | null;
  stopWaitMs?: number;
  onStarted?: DaemonSupervisorOptions['onStarted'];
}): Harness {
  let pidfile = opts.pidfile;
  const child = new FakeChild();
  const spawned: { env?: NodeJS.ProcessEnv; args: string[] }[] = [];
  const kills: { pid: number; signal: NodeJS.Signals }[] = [];
  const killedPids = new Set<number>();
  const removed: string[] = [];
  const options: DaemonSupervisorOptions = {
    spawn: ((cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv }) => {
      void cmd;
      // argv is recorded, not discarded: the daemon's inspector is a LAUNCH
      // flag, so argv is the only place the debugger toggle is observable.
      spawned.push({ ...o, args });
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
    checkBusy: async () => opts.busy ?? false,
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
    ...(opts.startTime ? { readStartTime: opts.startTime } : {}),
    ...(opts.stopWaitMs === undefined ? {} : { stopWaitMs: opts.stopWaitMs }),
    ...(opts.onStarted ? { onStarted: opts.onStarted } : {}),
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
  // Reset explicitly: it is a plain property, so a test that flips it to
  // reach the packaged branch would otherwise leak into every later spec —
  // silently changing whether the daemon spawns with an inspector.
  mocks.app.isPackaged = false;
  mocks.readSettings.mockReturnValue({
    ...DEFAULT_SETTINGS,
    onboardingComplete: true,
    cliPaths: { claude: '/opt/tools/claude' },
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
        startedAt: '2026-01-01T00:00:00.000Z',
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

  it('opens the inspector in dev by default, ahead of the entry script', async () => {
    // DEFAULT_SETTINGS leaves `daemonInspect` unchosen, and `isPackaged` is
    // false in this harness — the dev launch.
    const h = harness({ pidfile: null });

    await h.supervisor.start();

    expect(h.spawned).toHaveLength(1);
    // Order is load-bearing, not cosmetic: node reads `--inspect` only from
    // the argv AHEAD of the script path — placed after, it is handed to the
    // daemon as one of its own arguments and silently does nothing.
    expect(h.spawned[0]?.args).toEqual([
      `--inspect=127.0.0.1:${DAEMON_INSPECT_PORT}`,
      '/bundle/daemon/dist/main.js',
    ]);
  });

  it('opens no inspector in a packaged build, from the same unchosen setting', async () => {
    mocks.app.isPackaged = true;
    const h = harness({ pidfile: null });

    await h.supervisor.start();

    expect(h.spawned).toHaveLength(1);
    // Nothing debugger-shaped at all, rather than "not the exact string the
    // test above spells": an inspector opened under any spelling is what this
    // refuses, and `--inspect-brk` would additionally hang the daemon before
    // it ever listened.
    expect(h.spawned[0]?.args.filter((a) => a.startsWith('--inspect'))).toEqual(
      [],
    );
  });

  it('honours an explicit choice over the per-build default, in both directions', async () => {
    mocks.readSettings.mockReturnValue({
      ...DEFAULT_SETTINGS,
      onboardingComplete: true,
      daemonInspect: false,
    });
    const off = harness({ pidfile: null });
    await off.supervisor.start();
    // Dev, where the default is ON — a developer who closed the port keeps it
    // closed.
    expect(
      off.spawned[0]?.args.filter((a) => a.startsWith('--inspect')),
    ).toEqual([]);

    mocks.app.isPackaged = true;
    mocks.readSettings.mockReturnValue({
      ...DEFAULT_SETTINGS,
      onboardingComplete: true,
      daemonInspect: true,
    });
    const on = harness({ pidfile: null });
    await on.supervisor.start();
    // Packaged, where the default is OFF — a user debugging an installed app
    // gets the port they asked for.
    expect(on.spawned[0]?.args).toContain(
      `--inspect=127.0.0.1:${DAEMON_INSPECT_PORT}`,
    );
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
  it('replaces an adopted daemon and reloads CLI settings', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        pidfile: info({ pid: 1111, version: '0.2.0' }),
        graceMs: 25,
      });
      await h.supervisor.start();
      mocks.readSettings.mockReturnValue({
        ...DEFAULT_SETTINGS,
        onboardingComplete: true,
        cliPaths: { 'cursor-agent': '/opt/tools/cursor-agent' },
      });

      const restarted = h.supervisor.restart();
      await vi.advanceTimersByTimeAsync(50);
      await restarted;

      expect(h.kills).toEqual([
        { pid: 1111, signal: 'SIGTERM' },
        { pid: 1111, signal: 'SIGKILL' },
      ]);
      expect(h.spawned).toHaveLength(1);
      // The supervisor hands the daemon NO credential: cursor-agent carries its
      // own login. Re-adding the Keychain read would put this name back.
      expect(h.spawned[0]?.env?.GENIRO_CURSOR_API_KEY).toBeUndefined();
      expect(h.spawned[0]?.env?.GENIRO_CURSOR_BIN).toBe(
        '/opt/tools/cursor-agent',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('restart() overlapping a mid-boot start() waits for the boot instead of disowning the child', async () => {
    const h = harness({ pidfile: null, healthy: true });

    const started = h.supervisor.start();
    // The spawn already fired; the health poll is in flight.
    expect(h.spawned).toHaveLength(1);
    const restarted = h.supervisor.restart();

    await started;
    const handle = await restarted;

    // The freshly booted child is properly terminated as part of the restart
    // — never silently nulled out mid-boot (which orphaned it: no signal, no
    // ownership, invisible to stop()).
    expect(
      h.kills.some((k) => k.pid === h.child.pid && k.signal === 'SIGTERM'),
    ).toBe(true);
    expect(h.spawned).toHaveLength(2);
    expect(handle).not.toBeNull();
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
        ...DEFAULT_SETTINGS,
        onboardingComplete: true,
        cliPaths: { claude: '/opt/tools/claude-superseding' },
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

describe('DaemonSupervisor — a rebuilt daemon must not be adopted', () => {
  // The defect this pins, measured on the author's own machine: `pnpm dev` was
  // serving a daemon compiled FOUR DAYS earlier, missing a whole module that
  // had landed since. `version` is the package version, identical across every
  // rebuild, so the adoption check could never see it — and a rebuild appeared
  // to change nothing.
  let dir: string;
  let entry: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-entry-'));
    entry = join(dir, 'main.js');
    writeFileSync(entry, '// build one');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function supervisorFor(
    initial: DaemonInfo,
    kills: { pid: number; signal: NodeJS.Signals }[],
    spawned: { count: number },
    /** Overrides the resolved entry, for the "cannot stat my own" case. */
    resolved?: string,
    busy = false,
  ): DaemonSupervisor {
    const killed = new Set<number>();
    let pidfile = initial;
    return new DaemonSupervisor({
      spawn: ((): FakeChild => {
        spawned.count += 1;
        const child = new FakeChild();
        // A freshly spawned daemon writes its OWN pidfile, stamped with the
        // entry as it stands now. Without this the supervisor goes on reading
        // the stale record it has just replaced.
        const stats = statSync(entry);
        pidfile = info({
          pid: child.pid,
          entry: { path: entry, mtimeMs: stats.mtimeMs, size: stats.size },
        });
        return child;
      }) as unknown as DaemonSupervisorOptions['spawn'],
      readDaemonInfo: () => pidfile,
      isAlive: (pid) => !killed.has(pid),
      checkHealth: async () => true,
      checkIdentity: async () => true,
      checkBusy: async () => busy,
      killPid: (pid, signal) => {
        kills.push({ pid, signal });
        if (signal === 'SIGKILL') {
          killed.add(pid);
        }
      },
      resolveEntry: () => resolved ?? entry,
      bundledVersion: () => '0.1.0',
      removePidfile: () => undefined,
      pollIntervalMs: 1,
      shutdownGraceMs: 5,
    });
  }

  it('adopts a daemon started from the entry file as it stands now', async () => {
    const stats = statSync(entry);
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const spawned = { count: 0 };
    const supervisor = supervisorFor(
      info({
        entry: { path: entry, mtimeMs: stats.mtimeMs, size: stats.size },
      }),
      kills,
      spawned,
    );

    const handle = await supervisor.start();

    expect(handle.port).toBe(4823);
    expect(spawned.count).toBe(0);
    expect(kills).toEqual([]);
  });

  it('replaces a daemon whose entry file has been rebuilt since it started', async () => {
    const before = statSync(entry);
    // A rebuild: same path, same package version, different bytes. Without the
    // entry stamp this daemon is indistinguishable from the one above and is
    // adopted — which is the whole bug.
    writeFileSync(entry, '// build two, appreciably longer than build one');
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const spawned = { count: 0 };
    const supervisor = supervisorFor(
      info({
        pid: 1111,
        entry: { path: entry, mtimeMs: before.mtimeMs, size: before.size },
      }),
      kills,
      spawned,
    );

    await supervisor.start();

    expect(spawned.count).toBe(1);
    expect(kills.map((k) => k.pid)).toContain(1111);
  });

  it('leaves a daemon started from a DIFFERENT entry alone', async () => {
    // `pnpm daemon:dev` runs TypeScript source, not this dist bundle. It is a
    // different thing, not an old one, and killing it would take down a
    // developer's watch loop mid-edit.
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const spawned = { count: 0 };
    const supervisor = supervisorFor(
      info({
        entry: { path: join(dir, 'src', 'main.ts'), mtimeMs: 1, size: 1 },
      }),
      kills,
      spawned,
    );

    await supervisor.start();

    expect(spawned.count).toBe(0);
    expect(kills).toEqual([]);
  });

  it('REPLACES a daemon that reported no entry at all', async () => {
    // The launch this whole check exists for. Only this app writes the pidfile
    // and the field has been written since it existed, so its absence dates the
    // daemon to before the check — i.e. it is the multi-day-stale one, running
    // on the one launch where it is guaranteed to be there. Adopting it here
    // would make the feature miss its own target case.
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const spawned = { count: 0 };
    const supervisor = supervisorFor(
      info({ pid: 2222, entry: null }),
      kills,
      spawned,
    );

    await supervisor.start();

    expect(spawned.count).toBe(1);
    expect(kills.map((k) => k.pid)).toContain(2222);
  });

  it('adopts when it cannot stat its OWN entry', async () => {
    // Nothing to compare against. Killing a healthy daemon on no evidence
    // costs the user their in-flight turn, so "cannot tell" leaves it alone.
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const spawned = { count: 0 };
    const gone = join(dir, 'gone.js');
    const supervisor = supervisorFor(
      info({ entry: { path: gone, mtimeMs: 1, size: 1 } }),
      kills,
      spawned,
      gone,
    );

    await supervisor.start();

    expect(spawned.count).toBe(0);
    expect(kills).toEqual([]);
  });

  it('adopts a daemon whose RECORDED stamp is unreadable, instead of looping', async () => {
    // The respawned daemon would record the same unreadable stamp, so treating
    // this as stale terminates and respawns on every launch, forever.
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const spawned = { count: 0 };
    const supervisor = supervisorFor(
      info({ entry: { path: entry, mtimeMs: null, size: null } }),
      kills,
      spawned,
    );

    await supervisor.start();

    expect(spawned.count).toBe(0);
    expect(kills).toEqual([]);
  });
});

describe('DaemonSupervisor — guards on replacing a daemon we do not own', () => {
  let dir: string;
  let entry: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-guard-'));
    entry = join(dir, 'main.js');
    writeFileSync(entry, '// build one');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stale(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
    // Same path, a stamp that no longer matches the file: a rebuild.
    return info({
      pid: 3333,
      entry: { path: entry, mtimeMs: 1, size: 1 },
      ...overrides,
    });
  }

  interface Sink {
    kills: { pid: number; signal: NodeJS.Signals }[];
    spawned: { count: number };
  }
  const newSink = (): Sink => ({ kills: [], spawned: { count: 0 } });

  function supervisor(
    pidfile: DaemonInfo,
    sink: Sink,
    seams: {
      busy?: boolean | (() => Promise<boolean>);
      startTime?: number | null;
    } = {},
  ): DaemonSupervisor {
    const { busy = false } = seams;
    const killed = new Set<number>();
    let current = pidfile;
    return new DaemonSupervisor({
      spawn: ((): FakeChild => {
        sink.spawned.count += 1;
        const child = new FakeChild();
        // The replacement writes its own pidfile, stamped with the entry as it
        // stands now — otherwise the supervisor keeps reading the stale record.
        const stats = statSync(entry);
        current = info({
          pid: child.pid,
          entry: { path: entry, mtimeMs: stats.mtimeMs, size: stats.size },
          pidStartedAtMs: 5_000,
        });
        return child;
      }) as unknown as DaemonSupervisorOptions['spawn'],
      readDaemonInfo: () => current,
      isAlive: (pid) => !killed.has(pid),
      checkHealth: async () => true,
      checkIdentity: async () => true,
      checkBusy: typeof busy === 'function' ? busy : async () => busy,
      readStartTime: () =>
        seams.startTime === undefined ? 5_000 : seams.startTime,
      killPid: (pid, signal) => {
        sink.kills.push({ pid, signal });
        if (signal === 'SIGKILL') {
          killed.add(pid);
        }
      },
      resolveEntry: () => entry,
      bundledVersion: () => '0.1.0',
      removePidfile: () => undefined,
      pollIntervalMs: 1,
      shutdownGraceMs: 5,
    });
  }

  it('does NOT replace a stale daemon that is mid-turn', async () => {
    // Replacement tears down every agent child the daemon registered, and that
    // turn belongs to ANOTHER window — the user would see work die with nothing
    // saying why. Adopting a stale daemon is recoverable; this is not.
    const sink = newSink();
    await supervisor(stale({ pidStartedAtMs: 5_000 }), sink, {
      busy: true,
    }).start();

    expect(sink.spawned.count).toBe(0);
    expect(sink.kills).toEqual([]);
  });

  it('treats a daemon it cannot interrogate as busy', async () => {
    // Fail-safe direction: an unreachable status read must not read as idle.
    const sink = newSink();
    await supervisor(stale({ pidStartedAtMs: 5_000 }), sink, {
      busy: () => Promise.reject(new Error('connection reset')),
    }).start();

    expect(sink.spawned.count).toBe(0);
    expect(sink.kills).toEqual([]);
  });

  it('does NOT signal a pid whose start time disagrees with the record', async () => {
    // A recycled pid. `kill(pid, 0)` says alive and the port answers, but the
    // process behind that number is now someone else's — the user's own editor,
    // their own interactive CLI.
    const sink = newSink();
    await supervisor(stale({ pidStartedAtMs: 5_000 }), sink, {
      startTime: 900_000,
    }).start();

    expect(sink.kills).toEqual([]);
  });

  it('does NOT signal a pid whose start time cannot be read', async () => {
    const sink = newSink();
    await supervisor(stale({ pidStartedAtMs: 5_000 }), sink, {
      startTime: null,
    }).start();

    expect(sink.kills).toEqual([]);
  });

  it('replaces an idle, confirmed, stale daemon', async () => {
    // The control: with both guards satisfied the replacement still happens,
    // so neither guard has quietly disabled the feature.
    const sink = newSink();
    await supervisor(stale({ pidStartedAtMs: 5_000 }), sink, {
      startTime: 6_000,
    }).start();

    expect(sink.spawned.count).toBe(1);
    expect(sink.kills.map((k) => k.pid)).toContain(3333);
  });

  it('still replaces a daemon that recorded no start time', async () => {
    // A daemon older than the field. It cannot be confirmed, but it also cannot
    // be a recycled pid FOR this record — there is no record. Refusing here
    // would make the staleness check unreachable for exactly those daemons.
    const sink = newSink();
    await supervisor(stale({ pidStartedAtMs: null }), sink, {
      startTime: null,
    }).start();

    expect(sink.spawned.count).toBe(1);
  });
});

describe('DaemonSupervisor — a pidfile whose pid now belongs to someone else', () => {
  it('sweeps the record and starts a daemon, never signalling the stranger', async () => {
    // A daemon that died without cleaning up — SIGKILLed, crashed — leaves its
    // pidfile, and macOS hands its pid to something else. That something is
    // alive and does not answer /health, which used to fail EVERY launch with
    // "refusing to signal or start a second daemon", for good.
    const h = harness({
      pidfile: info({ pid: 1111, pidStartedAtMs: 5_000 }),
      alive: () => true,
      healthy: (current) => current?.pid !== 1111,
      startTime: () => 900_000,
    });

    const handle = await h.supervisor.start();

    expect(handle.version).toBe('0.2.0');
    expect(h.spawned).toHaveLength(1);
    expect(h.removed).toHaveLength(1);
    expect(h.kills).toEqual([]);
  });

  it('still fails closed when the start time cannot be READ — that is "cannot tell", not a mismatch', async () => {
    const h = harness({
      pidfile: info({ pid: 1111, pidStartedAtMs: 5_000 }),
      alive: () => true,
      healthy: false,
      startTime: () => null,
    });

    await expect(h.supervisor.start()).rejects.toThrow(
      /failed identity\/health verification/,
    );
    expect(h.spawned).toHaveLength(0);
    expect(h.kills).toEqual([]);
  });

  it('still fails closed when the recorded start time MATCHES — the daemon itself is not answering', async () => {
    const h = harness({
      pidfile: info({ pid: 1111, pidStartedAtMs: 5_000 }),
      alive: () => true,
      healthy: false,
      startTime: () => 5_500,
    });

    await expect(h.supervisor.start()).rejects.toThrow(
      /failed identity\/health verification/,
    );
    expect(h.spawned).toHaveLength(0);
  });
});

describe('DaemonSupervisor — start() is safe to call on a daemon it already holds', () => {
  it('returns its OWN running daemon as it is — still owned, so stop() still ends it, and not re-announced', async () => {
    // Launch, the Dock and the banner's Retry all call start(). It used to run
    // the adopt path again on a daemon this app had SPAWNED, marking it as
    // another instance's — and stop() leaves those running past quit.
    const started: unknown[] = [];
    const h = harness({
      pidfile: null,
      onStarted: (handle) => started.push(handle),
    });
    const first = await h.supervisor.start();

    const again = await h.supervisor.start();
    await h.supervisor.stop();

    expect(again).toBe(first);
    expect(h.spawned).toHaveLength(1);
    expect(started).toEqual([first]);
    expect(h.child.signals[0]).toBe('SIGTERM');
  });

  it('notices an ADOPTED daemon has died and starts a new one', async () => {
    // No exit event reaches a process that did not spawn the daemon, so the
    // held handle is only found stale by asking it.
    const dead = new Set<number>();
    const h = harness({
      pidfile: info({ pid: 1111, version: '0.2.0' }),
      alive: (pid) => !dead.has(pid),
      healthy: (current) => current !== null && !dead.has(current.pid),
    });
    await h.supervisor.start();
    expect(h.spawned).toHaveLength(0);
    dead.add(1111);

    const handle = await h.supervisor.start();

    expect(h.spawned).toHaveLength(1);
    expect(handle).toBe(h.supervisor.getHandle());
    expect(h.kills).toEqual([]);
  });

  it('fails closed on its OWN daemon when it stops answering — no kill, still owned', async () => {
    // Busy and wedged look the same from here, and a daemon that cannot be
    // asked is one whose turns nobody may end.
    let answering = true;
    const h = harness({ pidfile: null, healthy: () => answering });
    await h.supervisor.start();
    answering = false;

    await expect(h.supervisor.start()).rejects.toThrow(/not answering/);
    expect(h.child.signals).toEqual([]);
    expect(h.spawned).toHaveLength(1);

    await h.supervisor.stop();
    expect(h.child.signals[0]).toBe('SIGTERM');
  });

  it('stops calling an adopted daemon that no longer answers CONNECTED, even when nothing can replace it', async () => {
    // Alive, silent, and not provably someone else — the start fails closed,
    // and the handle it held must not go on being reported as a connection.
    let answering = true;
    const h = harness({
      pidfile: info({ pid: 1111, version: '0.2.0' }),
      alive: () => true,
      healthy: () => answering,
    });
    await h.supervisor.start();
    answering = false;

    await expect(h.supervisor.start()).rejects.toThrow(
      /failed identity\/health verification/,
    );

    expect(h.supervisor.getHandle()).toBeNull();
    expect(h.supervisor.isConnected()).toBe(false);
  });
});

describe('DaemonSupervisor — start() during an in-flight restart()', () => {
  it('JOINS the restart: one daemon, still owned, and stop() ends it', async () => {
    // Activating the app from the Dock mid-restart used to read the pidfile
    // the restart's new child had just written and ADOPT it as someone else's
    // (owned = false) — so stop() skipped it and it outlived quit.
    const dead = new Set<number>();
    let releaseHealth = (_healthy: boolean): void => undefined;
    let gate: Promise<boolean> | null = new Promise((resolve) => {
      releaseHealth = resolve;
    });
    const h = harness({
      pidfile: info({ pid: 1111, version: '0.2.0' }),
      alive: (pid) => !dead.has(pid),
      healthy: (current) => {
        if (current?.pid === 4242 && gate) {
          const held = gate;
          gate = null;
          return held;
        }
        return true;
      },
      onKill: (pid, signal) => {
        if (signal === 'SIGTERM' && pid === 1111) {
          dead.add(pid);
        }
      },
    });
    await h.supervisor.start();
    const restarted = h.supervisor.restart();
    // The restart has replaced the old daemon and is waiting on the new one.
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1));

    const started = h.supervisor.start();
    releaseHealth(true);
    const [fromRestart, fromStart] = await Promise.all([restarted, started]);
    await h.supervisor.stop();

    expect(fromStart).toBe(fromRestart);
    expect(h.spawned).toHaveLength(1);
    expect(h.child.signals[0]).toBe('SIGTERM');
  });
});

describe('DaemonSupervisor.stop — bounded', () => {
  it('does not wait forever on a start that never settles', async () => {
    // `before-quit` awaits this, so an unbounded wait is a ⌘Q that never
    // quits. The start here is parked on a health check that never answers.
    const h = harness({
      pidfile: info({ pid: 1111 }),
      alive: () => true,
      healthy: () => new Promise<boolean>(() => undefined),
      stopWaitMs: 30,
    });
    void h.supervisor.start().catch(() => undefined);

    await expect(h.supervisor.stop()).resolves.toBeUndefined();
  });
});

/** A spawn harness where every spawn is a NEW child, for the respawn cases. */
function respawner(
  opts: {
    delays?: number[];
    stableMs?: number;
    /** Children (by spawn index) that die before they ever answer. */
    bootFails?: (index: number) => boolean;
  } = {},
): {
  supervisor: DaemonSupervisor;
  children: FakeChild[];
  started: unknown[];
  logs: string[];
  die: (child: FakeChild) => void;
  exit: (
    child: FakeChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
} {
  const children: FakeChild[] = [];
  const started: unknown[] = [];
  const logs: string[] = [];
  let pidfile: DaemonInfo | null = null;
  // Tracked apart from `exitCode`, which a real child leaves null when a
  // SIGNAL ended it.
  const dead = new Set<FakeChild>();
  const exit = (
    child: FakeChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    dead.add(child);
    child.exitCode = code;
    child.emit('exit', code, signal);
  };
  const die = (child: FakeChild): void => exit(child, 1, null);
  const supervisor = new DaemonSupervisor({
    spawn: ((): FakeChild => {
      const index = children.length;
      const child = new FakeChild(5_000 + index);
      // A daemon that exits on SIGTERM, as the real one does.
      child.kill = (signal: NodeJS.Signals = 'SIGTERM'): boolean => {
        child.signals.push(signal);
        die(child);
        return true;
      };
      children.push(child);
      pidfile = info({ pid: child.pid, port: 5_000 + index, version: '0.2.0' });
      if (opts.bootFails?.(index)) {
        child.exitCode = 1;
        dead.add(child);
      }
      return child;
    }) as unknown as DaemonSupervisorOptions['spawn'],
    readDaemonInfo: () => pidfile,
    isAlive: (pid) =>
      children.some((child) => child.pid === pid && !dead.has(child)),
    checkHealth: async (_host, port) =>
      children.some(
        (child, index) => 5_000 + index === port && !dead.has(child),
      ),
    checkIdentity: async () => true,
    checkBusy: async () => false,
    killPid: (pid) => {
      const child = children.find((candidate) => candidate.pid === pid);
      if (child) {
        die(child);
      }
    },
    resolveEntry: () => '/bundle/daemon/dist/main.js',
    bundledVersion: () => '0.2.0',
    removePidfile: () => {
      pidfile = null;
    },
    pollIntervalMs: 1,
    shutdownGraceMs: 15,
    respawnDelaysMs: opts.delays ?? [5, 5],
    respawnStableMs: opts.stableMs ?? 60_000,
    onStarted: (handle) => started.push(handle),
    log: (_level, message) => logs.push(message),
  });
  return { supervisor, children, started, logs, die, exit };
}

/** Lets every pending respawn timer run and its start settle. */
const settleRespawns = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60));

describe('DaemonSupervisor — a daemon it OWNS that dies on its own', () => {
  it('is respawned, and the new one is announced', async () => {
    // Nothing used to: the exit only cleared state, and the banner's Retry
    // re-read a handle that no longer existed.
    const r = respawner();
    await r.supervisor.start();

    r.die(r.children[0]!);
    await settleRespawns();

    expect(r.children).toHaveLength(2);
    expect(r.started).toHaveLength(2);
    expect(r.supervisor.getHandle()).toBe(r.started[1]);
  });

  it('is NOT respawned when it stopped ITSELF — its idle exit is a SIGTERM at its own pid', async () => {
    // Respawning that would undo the idle exit every ten minutes for as long
    // as the app sits in the Dock with no window. Nest re-raises the signal
    // once its hooks have run, so that is what the exit carries.
    const r = respawner();
    await r.supervisor.start();

    r.exit(r.children[0]!, null, 'SIGTERM');
    await settleRespawns();

    expect(r.children).toHaveLength(1);
    expect(r.supervisor.getHandle()).toBeNull();
    expect(r.logs.join('\n')).toMatch(/stopped on request/);
  });

  it('is NOT respawned after a clean exit either', async () => {
    const r = respawner();
    await r.supervisor.start();

    r.exit(r.children[0]!, 0, null);
    await settleRespawns();

    expect(r.children).toHaveLength(1);
  });

  it('IS respawned after a SIGKILL — the OOM killer does not ask', async () => {
    const r = respawner();
    await r.supervisor.start();

    r.exit(r.children[0]!, null, 'SIGKILL');
    await settleRespawns();

    expect(r.children).toHaveLength(2);
  });

  it('is NOT respawned when stop() ended it', async () => {
    const r = respawner();
    await r.supervisor.start();

    await r.supervisor.stop();
    await settleRespawns();

    expect(r.children).toHaveLength(1);
    expect(r.logs.join('\n')).not.toMatch(/exited on its own/);
  });

  it('is NOT respawned when a restart() replaced it', async () => {
    const r = respawner();
    await r.supervisor.start();

    await r.supervisor.restart();
    await settleRespawns();

    // The restart's own replacement, and nothing after it.
    expect(r.children).toHaveLength(2);
    expect(r.logs.join('\n')).not.toMatch(/exited on its own/);
  });

  it('gives up at the end of its table, and a start() then brings it back with a fresh budget', async () => {
    // A daemon that dies on every boot would otherwise be spawned forever.
    const r = respawner({
      delays: [5, 5],
      bootFails: (index) => index === 1 || index === 2,
    });
    await r.supervisor.start();

    r.die(r.children[0]!);
    await settleRespawns();
    await settleRespawns();

    expect(r.children).toHaveLength(3);
    expect(r.supervisor.getHandle()).toBeNull();
    expect(r.logs.join('\n')).toMatch(/gave up after 2 respawn attempt/);

    // The banner's Retry.
    await r.supervisor.start();
    expect(r.children).toHaveLength(4);
    r.die(r.children[3]!);
    await settleRespawns();
    expect(r.children).toHaveLength(5);
  });

  it('starts a fresh budget for a daemon that had been serving long enough', async () => {
    // One attempt in the table: without the reset the SECOND death would find
    // it spent. A daemon that ran a while and then died is a new failure, not
    // the next one in a crash loop.
    const r = respawner({ delays: [5], stableMs: 0 });
    await r.supervisor.start();

    r.die(r.children[0]!);
    await settleRespawns();
    r.die(r.children[1]!);
    await settleRespawns();

    expect(r.children).toHaveLength(3);
    expect(r.supervisor.getHandle()).toBe(r.started[2]);
  });
});
