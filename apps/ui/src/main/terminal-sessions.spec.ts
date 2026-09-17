import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../shared/contracts';

const mocks = vi.hoisted(() => ({
  chmodSync: vi.fn(),
  userInfo: vi.fn(),
}));

// Only the two calls with side effects outside the test are replaced: the chmod
// of node-pty's real helper, and the user record the login shell is read from.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, chmodSync: mocks.chmodSync };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    userInfo: (...args: unknown[]) =>
      mocks.userInfo.getMockImplementation()
        ? mocks.userInfo(...args)
        : actual.userInfo(),
  };
});

const {
  FLOW_HIGH_WATER,
  FLOW_LOW_WATER,
  loginShell,
  MAX_SESSIONS_PER_OWNER,
  TerminalSessions,
  terminalEnv,
} = await import('./terminal-sessions');
type PtyLike = import('./terminal-sessions').PtyLike;
type PtySpawn = import('./terminal-sessions').PtySpawn;
type TerminalOwner = import('./terminal-sessions').TerminalOwner;

class FakePty implements PtyLike {
  readonly pid = 4242;
  readonly written: string[] = [];
  readonly resized: [number, number][] = [];
  readonly signals: (string | undefined)[] = [];
  throwOnKill = false;
  pauses = 0;
  resumes = 0;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener:
    ((event: { exitCode: number; signal?: number }) => void) | null = null;

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): void {
    this.exitListener = listener;
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }
  kill(signal?: string): void {
    if (this.throwOnKill) {
      throw new Error('ESRCH');
    }
    this.signals.push(signal);
  }
  pause(): void {
    this.pauses += 1;
  }
  resume(): void {
    this.resumes += 1;
  }
  emitData(data: string): void {
    this.dataListener?.(data);
  }
  emitExit(exitCode: number, signal?: number): void {
    this.exitListener?.({ exitCode, signal });
  }
}

function owner(id: number): TerminalOwner & {
  sent: [string, unknown][];
  destroyed: boolean;
} {
  const self = {
    id,
    sent: [] as [string, unknown][],
    destroyed: false,
    isDestroyed: () => self.destroyed,
    send: (channel: string, payload: unknown) => {
      self.sent.push([channel, payload]);
    },
  };
  return self;
}

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

describe('TerminalSessions', () => {
  let ptys: FakePty[];
  let calls: Parameters<PtySpawn>[];
  let sessions: InstanceType<typeof TerminalSessions>;
  let dir: string;

  beforeEach(() => {
    mocks.chmodSync.mockReset();
    ptys = [];
    calls = [];
    dir = mkdtempSync(join(tmpdir(), 'terminal-sessions-'));
    const spawn: PtySpawn = (...args) => {
      calls.push(args);
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    };
    sessions = new TerminalSessions({
      spawn,
      shell: '/bin/fake-shell',
      env: { PATH: '/usr/bin', GENIRO_USER_DATA: '/secret' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the login shell on a PTY in the folder it was given', async () => {
    await sessions.create(owner(1), {
      id: ID_A,
      cwd: dir,
      cols: 100,
      rows: 30,
    });

    const [file, args, options] = calls[0]!;
    expect(file).toBe('/bin/fake-shell');
    expect(args).toEqual(['-l']);
    expect(options).toMatchObject({
      cwd: dir,
      cols: 100,
      rows: 30,
      name: 'xterm-256color',
    });
    expect(options.env.PATH).toBe('/usr/bin');
    expect(options.env.GENIRO_USER_DATA).toBeUndefined();
  });

  it('opens in the home folder when no folder is named', async () => {
    await sessions.create(owner(1), { id: ID_A, cols: 80, rows: 24 });

    expect(calls[0]![2].cwd).toBe(homedir());
  });

  it('refuses a folder that no longer exists, naming it, and spawns nothing', async () => {
    const gone = join(dir, 'collected-worktree');

    await expect(
      sessions.create(owner(1), { id: ID_A, cwd: gone, cols: 80, rows: 24 }),
    ).rejects.toThrow(`the folder no longer exists: ${gone}`);
    expect(calls).toHaveLength(0);
  });

  it('refuses an id that is already running', async () => {
    await sessions.create(owner(1), { id: ID_A, cwd: dir, cols: 80, rows: 24 });

    await expect(
      sessions.create(owner(2), { id: ID_A, cwd: dir, cols: 80, rows: 24 }),
    ).rejects.toThrow(/already exists/);
    expect(calls).toHaveLength(1);
  });

  it('lets only one of two concurrent starts with the same id spawn', async () => {
    const results = await Promise.allSettled([
      sessions.create(owner(1), { id: ID_A, cwd: dir, cols: 80, rows: 24 }),
      sessions.create(owner(2), { id: ID_A, cwd: dir, cols: 80, rows: 24 }),
    ]);

    expect(calls).toHaveLength(1);
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
  });

  it('caps how many shells one window may hold, without capping another window', async () => {
    const a = owner(1);
    for (let i = 0; i < MAX_SESSIONS_PER_OWNER; i++) {
      await sessions.create(a, {
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        cwd: dir,
        cols: 80,
        rows: 24,
      });
    }

    await expect(
      sessions.create(a, { id: ID_A, cwd: dir, cols: 80, rows: 24 }),
    ).rejects.toThrow(/at most/);
    await expect(
      sessions.create(owner(2), { id: ID_A, cwd: dir, cols: 80, rows: 24 }),
    ).resolves.toBeUndefined();
  });

  it('restores the spawn helper’s exec bit once, and survives a bundle that refuses it', async () => {
    mocks.chmodSync.mockImplementation(() => {
      throw new Error('EROFS');
    });

    await sessions.create(owner(1), { id: ID_A, cwd: dir, cols: 80, rows: 24 });
    await sessions.create(owner(1), { id: ID_B, cwd: dir, cols: 80, rows: 24 });

    expect(mocks.chmodSync).toHaveBeenCalledOnce();
    expect(mocks.chmodSync.mock.calls[0]![0]).toMatch(
      /node-pty\/prebuilds\/[^/]+\/spawn-helper$/,
    );
    expect(mocks.chmodSync.mock.calls[0]![1]).toBe(0o755);
    expect(calls).toHaveLength(2);
  });

  it('coalesces a burst of output into one event, sent to the owner alone', async () => {
    vi.useFakeTimers();
    const a = owner(1);
    const b = owner(2);
    await sessions.create(a, { id: ID_A, cwd: dir, cols: 80, rows: 24 });
    await sessions.create(b, { id: ID_B, cwd: dir, cols: 80, rows: 24 });

    ptys[0]!.emitData('hel');
    ptys[0]!.emitData('lo');
    expect(a.sent).toHaveLength(0);
    vi.advanceTimersByTime(20);

    expect(a.sent).toEqual([[IPC.onTerminalData, { id: ID_A, data: 'hello' }]]);
    expect(b.sent).toHaveLength(0);
  });

  it('stops reading a shell whose output runs too far ahead of the screen, and resumes once it catches up', async () => {
    vi.useFakeTimers();
    const a = owner(1);
    await sessions.create(a, { id: ID_A, cwd: dir, cols: 80, rows: 24 });
    const pty = ptys[0]!;

    pty.emitData('x'.repeat(FLOW_HIGH_WATER));
    vi.advanceTimersByTime(20);
    expect(pty.pauses).toBe(0);
    pty.emitData('x');
    vi.advanceTimersByTime(20);
    expect(pty.pauses).toBe(1);

    // Another window's acknowledgement does not count.
    sessions.ack(owner(2), ID_A, FLOW_HIGH_WATER);
    expect(pty.resumes).toBe(0);

    sessions.ack(a, ID_A, FLOW_HIGH_WATER + 1 - FLOW_LOW_WATER - 1);
    expect(pty.resumes).toBe(0);
    sessions.ack(a, ID_A, 1);
    expect(pty.resumes).toBe(1);
    sessions.ack(a, ID_A, 1_000);
    expect(pty.resumes).toBe(1);
  });

  it('lets only the owning window write to, resize or kill a shell', async () => {
    const a = owner(1);
    const intruder = owner(2);
    await sessions.create(a, { id: ID_A, cwd: dir, cols: 80, rows: 24 });

    sessions.write(intruder, ID_A, 'rm -rf ~\r');
    sessions.resize(intruder, ID_A, 10, 10);
    sessions.kill(intruder, ID_A);
    expect(ptys[0]!.written).toEqual([]);
    expect(ptys[0]!.resized).toEqual([]);
    expect(ptys[0]!.signals).toEqual([]);

    sessions.write(a, ID_A, 'ls\r');
    sessions.resize(a, ID_A, 120, 40);
    expect(ptys[0]!.written).toEqual(['ls\r']);
    expect(ptys[0]!.resized).toEqual([[120, 40]]);
  });

  it('flushes pending output before the exit, then forgets the shell', async () => {
    vi.useFakeTimers();
    const a = owner(1);
    await sessions.create(a, { id: ID_A, cwd: dir, cols: 80, rows: 24 });

    ptys[0]!.emitData('logout\r\n');
    ptys[0]!.emitExit(0, 0);

    // node-pty reports signal 0 for a shell nothing killed; the event says null.
    expect(a.sent).toEqual([
      [IPC.onTerminalData, { id: ID_A, data: 'logout\r\n' }],
      [IPC.onTerminalExit, { id: ID_A, exitCode: 0, signal: null }],
    ]);
    sessions.write(a, ID_A, 'late keystroke');
    expect(ptys[0]!.written).toEqual([]);
    await expect(
      sessions.create(a, { id: ID_A, cwd: dir, cols: 80, rows: 24 }),
    ).resolves.toBeUndefined();
  });

  it('reports the signal that killed a shell', async () => {
    const a = owner(1);
    await sessions.create(a, { id: ID_A, cwd: dir, cols: 80, rows: 24 });

    ptys[0]!.emitExit(0, 9);

    expect(a.sent).toEqual([
      [IPC.onTerminalExit, { id: ID_A, exitCode: 0, signal: 9 }],
    ]);
  });

  it('hangs up a closed window’s shells, and SIGKILLs one that ignores the hangup', async () => {
    vi.useFakeTimers();
    await sessions.create(owner(1), { id: ID_A, cwd: dir, cols: 80, rows: 24 });
    await sessions.create(owner(2), { id: ID_B, cwd: dir, cols: 80, rows: 24 });

    sessions.disposeOwner(1);

    expect(ptys[0]!.signals).toEqual(['SIGHUP']);
    expect(ptys[1]!.signals).toEqual([]);
    vi.advanceTimersByTime(3_000);
    expect(ptys[0]!.signals).toEqual(['SIGHUP', 'SIGKILL']);
  });

  it('does not SIGKILL a shell that exited on the hangup', async () => {
    vi.useFakeTimers();
    await sessions.create(owner(1), { id: ID_A, cwd: dir, cols: 80, rows: 24 });

    sessions.kill(owner(1), ID_A);
    ptys[0]!.emitExit(0, 1);
    vi.advanceTimersByTime(3_000);

    expect(ptys[0]!.signals).toEqual(['SIGHUP']);
  });

  it('survives a SIGKILL on a shell that died in the same tick', async () => {
    vi.useFakeTimers();
    await sessions.create(owner(1), { id: ID_A, cwd: dir, cols: 80, rows: 24 });
    sessions.disposeOwner(1);
    ptys[0]!.throwOnKill = true;

    expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
  });

  it('hangs every shell up at quit without arming an escalation', async () => {
    vi.useFakeTimers();
    await sessions.create(owner(1), { id: ID_A, cwd: dir, cols: 80, rows: 24 });
    await sessions.create(owner(2), { id: ID_B, cwd: dir, cols: 80, rows: 24 });

    sessions.disposeAll();
    vi.advanceTimersByTime(3_000);

    expect(ptys.map((pty) => pty.signals)).toEqual([['SIGHUP'], ['SIGHUP']]);
  });

  it('survives a kill on a process that is already gone', async () => {
    await sessions.create(owner(1), { id: ID_A, cwd: dir, cols: 80, rows: 24 });
    ptys[0]!.throwOnKill = true;

    expect(() => sessions.disposeOwner(1)).not.toThrow();
  });

  it('sends nothing to a window that has been destroyed', async () => {
    vi.useFakeTimers();
    const a = owner(1);
    await sessions.create(a, { id: ID_A, cwd: dir, cols: 80, rows: 24 });
    a.destroyed = true;

    ptys[0]!.emitData('x');
    vi.advanceTimersByTime(20);
    ptys[0]!.emitExit(1);

    expect(a.sent).toEqual([]);
  });
});

describe('TerminalSessions without an injected spawn', () => {
  afterEach(() => {
    vi.doUnmock('node-pty');
    vi.resetModules();
  });

  it('loads node-pty on the first shell, so an addon that fails to load costs that shell and not the launch', async () => {
    vi.resetModules();
    vi.doMock('node-pty', () => {
      throw new Error('dlopen failed: pty.node');
    });
    const fresh = await import('./terminal-sessions');

    // Importing the module and constructing the service both touch no addon.
    const sessions = new fresh.TerminalSessions({ shell: '/bin/fake-shell' });

    await expect(
      sessions.create(owner(1), { id: ID_A, cols: 80, rows: 24 }),
      // vitest rewraps a throwing mock factory's error, so only its arrival as a
      // REJECTION — rather than a failed module import above — is asserted.
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('loginShell', () => {
  const savedShell = process.env.SHELL;

  afterEach(() => {
    mocks.userInfo.mockReset();
    process.env.SHELL = savedShell;
  });

  it('reads the shell from the user record, not from SHELL', () => {
    mocks.userInfo.mockImplementation(() => ({
      shell: '/opt/homebrew/bin/fish',
    }));
    process.env.SHELL = '/bin/bash';

    expect(loginShell()).toBe('/opt/homebrew/bin/fish');
  });

  it('falls back to SHELL, then to zsh, when the record names none', () => {
    mocks.userInfo.mockImplementation(() => ({ shell: null }));
    process.env.SHELL = '/bin/bash';
    expect(loginShell()).toBe('/bin/bash');

    mocks.userInfo.mockImplementation(() => {
      throw new Error('no passwd entry');
    });
    delete process.env.SHELL;
    expect(loginShell()).toBe('/bin/zsh');
  });
});

describe('terminalEnv', () => {
  it('drops this process’s own config and runtime flags, and keeps the user’s environment', () => {
    const env = terminalEnv({
      HOME: '/Users/me',
      ANTHROPIC_API_KEY: 'users-own-key',
      GENIRO_USER_DATA: '/data',
      ELECTRON_RUN_AS_NODE: '1',
      npm_config_prefix: '/pnpm',
    });

    expect(env.HOME).toBe('/Users/me');
    expect(env.ANTHROPIC_API_KEY).toBe('users-own-key');
    expect(env.GENIRO_USER_DATA).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.npm_config_prefix).toBeUndefined();
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
  });

  it('supplies a UTF-8 locale only when the launch carried none', () => {
    expect(terminalEnv({}).LANG).toBe('en_US.UTF-8');
    expect(terminalEnv({ LANG: 'ru_RU.UTF-8' }).LANG).toBe('ru_RU.UTF-8');
  });
});
