import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';
import { spawn as spawnNodePty } from 'node-pty';
import { Observable, Subject } from 'rxjs';

import type { AgentTurnHandle } from '../../agents/adapters/adapter.types';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { buildChildEnv } from '../../agents/utils/child-env';
import { killProcessGroup } from '../../agents/utils/kill-tree';
import type {
  TerminalEvent,
  TerminalSessionWire,
  TerminalStatus,
} from '../terminals.types';

/** Max buffered scrollback per session (chars) replayed to a (re)attaching client. */
const SCROLLBACK_CAP = 512 * 1024;
/**
 * Grace between the polite kill signal and the SIGKILL escalation. Coupled:
 * must stay ≤ the registry drain (SHUTDOWN_DRAIN_MS = 5s,
 * ../../agents/services/process-registry.ts) so the escalation can fire within
 * a graceful daemon shutdown, which itself sits under the UI's 7s kill grace.
 */
const KILL_ESCALATION_MS = 3000;
/** How long an exited session's final screen stays re-attachable before eviction. */
const EXITED_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Terminal-size bounds — shared with the HTTP DTO so the two never diverge. */
export const MAX_COLS = 500;
export const MAX_ROWS = 300;

/**
 * The slice of node-pty's `IPty` this service depends on — narrower than the
 * real interface so tests can supply a fake (mirrors `SpawnedProcess`).
 */
export interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtySpawnFn = (
  command: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => PtyLike;

/** Test seams, not user config — provided via a factory in the module. */
export interface PtyServiceOptions {
  spawnPty?: PtySpawnFn;
  killEscalationMs?: number;
}

export interface CreateTerminalInput {
  runId: string;
  nodeId: string | null;
  /** The CLI session this mirror resumes (its thread identity), if any. */
  resumeSessionId?: string | null;
  command: string;
  args: string[];
  /** Pre-validated absolute cwd (callers run `resolveValidCwd` first). */
  cwd: string;
  cols?: number;
  rows?: number;
}

interface PtySession {
  id: string;
  runId: string;
  nodeId: string | null;
  resumeSessionId: string | null;
  cwd: string;
  pty: PtyLike;
  scrollback: string[];
  scrollbackLength: number;
  status: TerminalStatus;
  exitCode: number | null;
  events: Subject<TerminalEvent>;
  createdAt: number;
  killTimer?: NodeJS.Timeout;
  evictTimer?: NodeJS.Timeout;
}

/**
 * pnpm extracts node-pty's prebuilt `spawn-helper` without its exec bit, which
 * makes every spawn die with `posix_spawnp failed`. The root postinstall fixes
 * fresh installs; this runtime guard covers the short-circuited-install case.
 * Best-effort and once per process — a source-built node-pty has no prebuilds
 * directory and needs nothing.
 */
let spawnHelperEnsured = false;
function ensureSpawnHelperExecutable(): void {
  if (spawnHelperEnsured || process.platform === 'win32') {
    return;
  }
  spawnHelperEnsured = true;
  try {
    const pkgDir = dirname(require.resolve('node-pty/package.json'));
    chmodSync(
      join(
        pkgDir,
        'prebuilds',
        `${process.platform}-${process.arch}`,
        'spawn-helper',
      ),
      0o755,
    );
  } catch {
    // No prebuild layout (source build) or already fixed — nothing to do.
  }
}

/**
 * Owns every live PTY mirror session: spawn (env-stripped via
 * {@link buildChildEnv}), scrollback buffering for (re)attach replay, byte
 * fan-out, resize, and the kill path. Every PTY child registers with
 * {@link ProcessRegistry} under `terminal:<id>` — the prefix keeps a mirror
 * from marking its run "busy" for chat turns — so cancel and daemon shutdown
 * reap it like any other spawned child. Sessions are in-memory only: a live
 * mirror is not history, so nothing touches SQLite.
 */
@Injectable()
export class PtyService {
  private readonly logger = new Logger(PtyService.name);
  private readonly sessions = new Map<string, PtySession>();
  private readonly spawnPty: PtySpawnFn;
  private readonly killEscalationMs: number;

  constructor(
    private readonly registry: ProcessRegistry,
    options: PtyServiceOptions = {},
  ) {
    this.spawnPty = options.spawnPty ?? (spawnNodePty as PtySpawnFn);
    this.killEscalationMs = options.killEscalationMs ?? KILL_ESCALATION_MS;
  }

  create(input: CreateTerminalInput): TerminalSessionWire {
    ensureSpawnHelperExecutable();
    const id = randomUUID();
    const registryKey = `terminal:${id}`;
    if (!this.registry.tryClaim(registryKey)) {
      // A fresh UUID cannot collide; defensive so a bug never double-spawns.
      throw new ConflictException(
        'TERMINAL_BUSY',
        `terminal ${id} is already claimed`,
      );
    }

    let pty: PtyLike;
    try {
      pty = this.spawnPty(input.command, input.args, {
        name: 'xterm-256color',
        cols: clamp(input.cols ?? DEFAULT_COLS, 1, MAX_COLS),
        rows: clamp(input.rows ?? DEFAULT_ROWS, 1, MAX_ROWS),
        cwd: input.cwd,
        env: stringEnv(buildChildEnv({ TERM: 'xterm-256color' })),
      });
    } catch (err) {
      this.registry.release(registryKey);
      throw err;
    }

    const session: PtySession = {
      id,
      runId: input.runId,
      nodeId: input.nodeId,
      resumeSessionId: input.resumeSessionId ?? null,
      cwd: input.cwd,
      pty,
      scrollback: [],
      scrollbackLength: 0,
      status: 'running',
      exitCode: null,
      events: new Subject<TerminalEvent>(),
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);

    pty.onData((data) => {
      session.scrollback.push(data);
      session.scrollbackLength += data.length;
      while (
        session.scrollbackLength > SCROLLBACK_CAP &&
        session.scrollback.length > 1
      ) {
        const dropped = session.scrollback.shift();
        session.scrollbackLength -= dropped?.length ?? 0;
      }
      session.events.next({ kind: 'data', data });
    });

    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    pty.onExit(({ exitCode }) => {
      if (session.killTimer) {
        clearTimeout(session.killTimer);
        session.killTimer = undefined;
      }
      session.status = 'exited';
      session.exitCode = exitCode;
      session.events.next({ kind: 'exit', exitCode });
      session.events.complete();
      // Keep the exited session around briefly so a re-attach can replay the
      // final screen, then evict — without a TTL every abandoned session pins
      // up to SCROLLBACK_CAP of memory for the daemon's lifetime.
      session.evictTimer = setTimeout(() => {
        this.sessions.delete(id);
      }, EXITED_SESSION_TTL_MS);
      session.evictTimer.unref?.();
      settle();
    });

    const handle: AgentTurnHandle = {
      done,
      cancel: () => this.kill(id),
      respondApproval: () => false,
    };
    this.registry.register(registryKey, handle);
    return this.toWire(session);
  }

  get(id: string): TerminalSessionWire {
    return this.toWire(this.session(id));
  }

  /**
   * The still-active session for a (run, node, resume-session) target, or
   * null. Lets the create path stay idempotent per mirror target — the daemon
   * owns that invariant rather than trusting every client to do a
   * list-then-create dance. A `closing` session counts as busy: its PTY may
   * live for up to the kill-escalation grace, and spawning a sibling would
   * put two `--resume` TUIs on one CLI session file.
   */
  findRunning(
    runId: string,
    nodeId: string | null,
    resumeSessionId: string | null = null,
  ): TerminalSessionWire | null {
    for (const session of this.sessions.values()) {
      if (
        session.runId === runId &&
        session.nodeId === nodeId &&
        session.resumeSessionId === resumeSessionId &&
        session.status !== 'exited'
      ) {
        return this.toWire(session);
      }
    }
    return null;
  }

  list(): TerminalSessionWire[] {
    return [...this.sessions.values()].map((s) => this.toWire(s));
  }

  /** Buffered output replayed to a client attaching mid-session. */
  scrollback(id: string): string {
    return this.session(id).scrollback.join('');
  }

  /**
   * Live event stream for one session. Attach protocol: read {@link scrollback}
   * and subscribe in the same synchronous tick — PTY events fire on later ticks,
   * so no byte can slip between the snapshot and the subscription.
   */
  stream(id: string): Observable<TerminalEvent> {
    return this.session(id).events.asObservable();
  }

  write(id: string, data: string): void {
    const session = this.session(id);
    if (session.status === 'running') {
      session.pty.write(data);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.session(id);
    if (session.status === 'running') {
      session.pty.resize(clamp(cols, 1, MAX_COLS), clamp(rows, 1, MAX_ROWS));
    }
  }

  /**
   * Polite kill (SIGHUP via the pty), escalating to a process-GROUP SIGKILL
   * after the grace. Idempotent for a `closing` session (dispose already sent
   * the signal) and tolerates an unknown id: the registry handle's `cancel`
   * can fire on daemon shutdown AFTER an exited session was disposed away, and
   * a throw here would abort the registry's cancel loop mid-way, orphaning
   * every child behind it (cancel is a never-throws contract).
   */
  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.status === 'exited') {
      return;
    }
    try {
      session.pty.kill();
    } catch {
      // Already gone — the exit handler settles the session.
    }
    if (!session.killTimer) {
      session.killTimer = setTimeout(() => {
        if (session.status !== 'exited') {
          killProcessGroup(session.pty.pid, 'SIGKILL', () =>
            process.kill(session.pty.pid, 'SIGKILL'),
          );
        }
      }, this.killEscalationMs);
      session.killTimer.unref?.();
    }
  }

  /**
   * The explicit close path. A running session is killed but stays mapped as
   * `closing` until its PTY actually exits — deleting here would make the
   * dying PTY invisible to {@link findRunning}, letting an instant reopen race
   * a second `--resume` onto the same CLI session. An exited session is
   * forgotten immediately.
   */
  dispose(id: string): void {
    const session = this.session(id);
    if (session.status === 'running') {
      this.kill(id);
      session.status = 'closing';
      return;
    }
    if (session.status === 'closing') {
      return; // kill already in flight; onExit settles the session
    }
    if (session.evictTimer) {
      clearTimeout(session.evictTimer);
    }
    this.sessions.delete(id);
  }

  private session(id: string): PtySession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new NotFoundException(
        'TERMINAL_NOT_FOUND',
        `no terminal session: ${id}`,
      );
    }
    return session;
  }

  private toWire(session: PtySession): TerminalSessionWire {
    return {
      id: session.id,
      runId: session.runId,
      nodeId: session.nodeId,
      resumeSessionId: session.resumeSessionId,
      cwd: session.cwd,
      status: session.status,
      exitCode: session.exitCode,
      createdAt: session.createdAt,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** node-pty requires string-valued env; drop the undefined slots. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}
