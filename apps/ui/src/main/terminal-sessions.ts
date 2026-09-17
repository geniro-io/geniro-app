import { chmodSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import {
  IPC,
  type TerminalCreateInput,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from '../shared/contracts';

/** How long output is coalesced before it crosses to the renderer. */
const FLUSH_MS = 8;
/** A shell that ignores SIGHUP is SIGKILLed after this long. */
const KILL_ESCALATION_MS = 3_000;
/**
 * Output the renderer has been sent but not yet drawn, in characters. Past the
 * high mark the PTY stops being read, so a shell printing faster than xterm can
 * paint blocks on its own write instead of queueing IPC without bound; it is
 * read again once the renderer has caught up to the low mark.
 */
export const FLOW_HIGH_WATER = 256_000;
export const FLOW_LOW_WATER = 32_000;
/** Per window: a runaway loop in the renderer must not fork-bomb the machine. */
export const MAX_SESSIONS_PER_OWNER = 20;

/**
 * Environment prefixes a user's shell must not inherit from this process:
 * `GENIRO_` is the daemon's own config, `ELECTRON_` would turn any Electron app
 * launched from the terminal into a bare Node (`ELECTRON_RUN_AS_NODE`), and
 * `npm_` is `pnpm dev`'s script context leaking into the user's `npm`.
 */
const STRIPPED_ENV_PREFIXES = ['GENIRO_', 'ELECTRON_', 'npm_'] as const;

/** The slice of node-pty's `IPty` this module uses — narrow so a spec can fake it. */
export interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => PtyLike;

/** The WebContents a session belongs to — only what this module touches. */
export interface TerminalOwner {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

interface Session {
  readonly id: string;
  readonly owner: TerminalOwner;
  readonly pty: PtyLike;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  unacked: number;
  paused: boolean;
}

export interface TerminalSessionsOptions {
  /** node-pty's `spawn` unless given — loaded on the first shell, not at launch. */
  spawn?: PtySpawn;
  /** The login shell; resolved from the user record when omitted. */
  shell?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The shells behind the in-app terminal panel, one PTY per tab.
 *
 * Owned by MAIN because the renderer is sandboxed and node-pty is native. Every
 * session belongs to the WebContents that created it: only that one may write
 * to, resize or kill it, and only that one is sent its output — so one window
 * cannot type into another's shell.
 *
 * Nothing here needs a child journal: a PTY's shell is the leader of its own
 * session on the PTY, so when this process dies — SIGKILL included — the kernel
 * closes the master side and hangs the whole session up.
 *
 * node-pty is imported lazily, on the first shell: it is a native addon, and one
 * that fails to load must cost the terminal panel, never the app's launch.
 */
export class TerminalSessions {
  private readonly sessions = new Map<string, Session>();
  private spawn: PtySpawn | null;
  private readonly shell: string;
  private readonly env: NodeJS.ProcessEnv;
  private spawnHelperChecked = false;

  constructor(options: TerminalSessionsOptions = {}) {
    this.spawn = options.spawn ?? null;
    this.shell = options.shell ?? loginShell();
    this.env = options.env ?? process.env;
  }

  async create(
    owner: TerminalOwner,
    input: TerminalCreateInput,
  ): Promise<void> {
    // Loaded BEFORE the checks below, so nothing can slip between a check and
    // the spawn it guards.
    const spawn = await this.loadSpawn();
    if (this.sessions.has(input.id)) {
      throw new Error(`terminal ${input.id} already exists`);
    }
    if (this.ownedBy(owner).length >= MAX_SESSIONS_PER_OWNER) {
      throw new Error(
        `at most ${MAX_SESSIONS_PER_OWNER} terminals can be open at once`,
      );
    }
    const cwd = input.cwd ?? homedir();
    // node-pty reports a missing cwd as a bare `posix_spawnp failed`, which names
    // nothing — and a task's worktree is routinely collected under an open chat.
    if (!isDirectory(cwd)) {
      throw new Error(`the folder no longer exists: ${cwd}`);
    }
    const pty = spawn(this.shell, ['-l'], {
      name: 'xterm-256color',
      cols: input.cols,
      rows: input.rows,
      cwd,
      env: terminalEnv(this.env),
    });
    const session: Session = {
      id: input.id,
      owner,
      pty,
      pending: '',
      flushTimer: null,
      killTimer: null,
      unacked: 0,
      paused: false,
    };
    this.sessions.set(input.id, session);
    pty.onData((data) => this.queue(session, data));
    pty.onExit(({ exitCode, signal }) => {
      this.flush(session);
      if (session.killTimer) {
        clearTimeout(session.killTimer);
      }
      this.sessions.delete(session.id);
      const event: TerminalExitEvent = {
        id: session.id,
        exitCode,
        // node-pty reports 0, not undefined, for a shell no signal ended.
        signal: signal ? signal : null,
      };
      this.send(session, IPC.onTerminalExit, event);
    });
  }

  // write/resize/kill IGNORE an id they do not find for this owner: a keystroke
  // racing the shell's own exit is ordinary, and another window's id is not
  // this sender's to learn about.
  write(owner: TerminalOwner, id: string, data: string): void {
    this.find(owner, id)?.pty.write(data);
  }

  resize(owner: TerminalOwner, id: string, cols: number, rows: number): void {
    this.find(owner, id)?.pty.resize(cols, rows);
  }

  /** The renderer has drawn `chars` more of this shell's output. */
  ack(owner: TerminalOwner, id: string, chars: number): void {
    const session = this.find(owner, id);
    if (!session) {
      return;
    }
    session.unacked = Math.max(0, session.unacked - chars);
    if (session.paused && session.unacked <= FLOW_LOW_WATER) {
      session.paused = false;
      session.pty.resume();
    }
  }

  kill(owner: TerminalOwner, id: string): void {
    const session = this.find(owner, id);
    if (session) {
      this.terminate(session, true);
    }
  }

  /** Every shell a window owns — on its close, crash or reload. */
  disposeOwner(ownerId: number): void {
    for (const session of this.sessions.values()) {
      if (session.owner.id === ownerId) {
        this.terminate(session, true);
      }
    }
  }

  /** At quit: SIGHUP only, since no timer would outlive the process to escalate. */
  disposeAll(): void {
    for (const session of this.sessions.values()) {
      this.terminate(session, false);
    }
  }

  private async loadSpawn(): Promise<PtySpawn> {
    if (this.spawn === null) {
      const nodePty = await import('node-pty');
      this.spawn = nodePty.spawn as PtySpawn;
    }
    this.ensureSpawnHelperExecutable();
    return this.spawn;
  }

  /**
   * pnpm can extract node-pty's prebuilt `spawn-helper` without its exec bit, and
   * every spawn then dies with `posix_spawnp failed`. The postinstall repairs a
   * fresh install; this covers an install that skipped it. Inside a packaged app
   * the bundle is signed and read-only and the build script sets the bit, so a
   * failure here is expected.
   */
  private ensureSpawnHelperExecutable(): void {
    if (this.spawnHelperChecked) {
      return;
    }
    this.spawnHelperChecked = true;
    try {
      const dir = dirname(require.resolve('node-pty/package.json'));
      chmodSync(
        join(
          dir,
          'prebuilds',
          `${process.platform}-${process.arch}`,
          'spawn-helper',
        ),
        0o755,
      );
    } catch {
      // Source build, read-only bundle, or already executable.
    }
  }

  private find(owner: TerminalOwner, id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session && session.owner.id === owner.id ? session : undefined;
  }

  private ownedBy(owner: TerminalOwner): Session[] {
    return [...this.sessions.values()].filter((s) => s.owner.id === owner.id);
  }

  private terminate(session: Session, escalate: boolean): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    try {
      session.pty.kill('SIGHUP');
    } catch {
      // Already gone — its exit event does the bookkeeping.
      return;
    }
    if (escalate && !session.killTimer) {
      // The exit handler clears this timer, so it only fires on a live shell.
      session.killTimer = setTimeout(() => {
        try {
          session.pty.kill('SIGKILL');
        } catch {
          // Exited in the same tick as the timer.
        }
      }, KILL_ESCALATION_MS);
      session.killTimer.unref();
    }
  }

  private queue(session: Session, data: string): void {
    session.pending += data;
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.flush(session), FLUSH_MS);
    }
  }

  private flush(session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (session.pending === '') {
      return;
    }
    const event: TerminalDataEvent = { id: session.id, data: session.pending };
    session.unacked += session.pending.length;
    session.pending = '';
    this.send(session, IPC.onTerminalData, event);
    if (!session.paused && session.unacked > FLOW_HIGH_WATER) {
      session.paused = true;
      session.pty.pause();
    }
  }

  private send(session: Session, channel: string, payload: unknown): void {
    if (!session.owner.isDestroyed()) {
      session.owner.send(channel, payload);
    }
  }
}

/**
 * The user's login shell from the user RECORD rather than `SHELL`: a packaged
 * Finder launch inherits launchd's environment, where `SHELL` may be unset.
 */
export function loginShell(): string {
  try {
    const shell = userInfo().shell;
    if (shell) {
      return shell;
    }
  } catch {
    // No passwd entry for this uid — fall through.
  }
  return process.env.SHELL || '/bin/zsh';
}

export function terminalEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      !STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Geniro';
  // A Finder launch carries no locale, and zsh then mangles every non-ASCII
  // character typed at the prompt.
  if (!env.LANG) {
    env.LANG = 'en_US.UTF-8';
  }
  return env;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
