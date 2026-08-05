import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';
import { spawn as spawnNodePty } from 'node-pty';
import { Observable, Subject, type Subscription } from 'rxjs';

import type { AgentTurnHandle } from '../../agents/adapters/adapter.types';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { CappedTextBuffer } from '../../agents/utils/capped-text-buffer';
import { buildChildEnv } from '../../agents/utils/child-env';
import { killProcessGroup } from '../../agents/utils/kill-tree';
import {
  MAX_COLS,
  MAX_ROWS,
  type TerminalEvent,
  type TerminalKind,
  type TerminalSessionWire,
  type TerminalStatus,
} from '../terminals.types';

/**
 * Grace between the polite kill signal and the SIGKILL escalation. Coupled:
 * must stay ≤ the registry drain (SHUTDOWN_DRAIN_MS = 5s,
 * ../../agents/services/process-registry.ts) so the escalation can fire within
 * a graceful daemon shutdown, which itself sits under the UI's 7s kill grace.
 */
const KILL_ESCALATION_MS = 3000;
/** How long an exited session's final screen stays re-attachable before eviction. */
// Exported so the spec pins eviction against the live constant.
export const EXITED_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

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
export interface TerminalSessionsOptions {
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
  /** Extra env merged over the stripped child env (single-secret re-injection). */
  env?: Record<string, string>;
}

/**
 * A session over an EXISTING byte stream rather than a process this service
 * spawns — the live mirror of a run's own headless turns.
 *
 * The caller supplies the bytes (`snapshot` + `source`) so this service stays
 * ignorant of where they come from: it owns session lifecycle, scrollback and
 * fan-out, all of which are the same whether a PTY or a tee produced the text.
 */
export interface CreateMirrorInput {
  runId: string;
  nodeId: string | null;
  /** Informational only — a mirror spawns nothing, so nothing runs here. */
  cwd: string;
  /** Everything buffered before this session existed, replayed on attach. */
  snapshot: string;
  /**
   * Appends from now on. Read `snapshot` and pass this in the SAME synchronous
   * tick, or bytes fall between the two.
   */
  source: Observable<string>;
}

interface Session {
  id: string;
  kind: TerminalKind;
  runId: string;
  nodeId: string | null;
  resumeSessionId: string | null;
  cwd: string;
  /**
   * The process this session mirrors, or null for a `live` session — which
   * watches a turn someone else spawned and owns no child of its own. Every
   * process-touching path (write, resize, kill, the group-SIGKILL escalation)
   * is guarded on it: a null pty has no pid, and a pid-shaped default reaching
   * `killProcessGroup` would signal the daemon's OWN group.
   */
  pty: PtyLike | null;
  /** Buffered output replayed to a (re)attaching client, newest-wins. */
  scrollback: CappedTextBuffer;
  /** Unsubscribes a `live` session from its source on dispose. */
  mirrorSub?: Subscription;
  status: TerminalStatus;
  exitCode: number | null;
  events: Subject<TerminalEvent>;
  createdAt: number;
  killTimer?: NodeJS.Timeout;
  evictTimer?: NodeJS.Timeout;
  /**
   * Set by {@link TerminalSessionsService.dispose} on a running session: the user closed
   * this mirror on purpose, so on exit it is forgotten immediately instead of
   * held (scrollback and all) for the abandoned-session replay TTL.
   */
  disposedExplicitly?: boolean;
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
 * Owns every terminal-mirror session, of both kinds: `interactive` ones it
 * SPAWNS (a `--resume` CLI child under a PTY) and `live` ones it merely WATCHES
 * (the tee of a headless turn someone else spawned — see {@link createMirror}).
 *
 * Named for SESSIONS rather than for PTYs because that is what it owns, and
 * because what it owns is the same for both kinds: lifecycle, scrollback
 * buffering for (re)attach replay, byte fan-out, and settling. Only
 * spawn/write/resize/kill are PTY-specific, and each is guarded on the session
 * having a process at all.
 *
 * For the spawning half: spawn is env-stripped via
 * {@link buildChildEnv}, and every PTY child registers with
 * {@link ProcessRegistry} under `terminal:<id>` — the prefix keeps a mirror
 * from marking its run "busy" for chat turns — so cancel and daemon shutdown
 * reap it like any other spawned child. Sessions are in-memory only: a live
 * mirror is not history, so nothing touches SQLite.
 */
@Injectable()
export class TerminalSessionsService {
  private readonly logger = new Logger(TerminalSessionsService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly spawnPty: PtySpawnFn;
  private readonly killEscalationMs: number;

  constructor(
    private readonly registry: ProcessRegistry,
    options: TerminalSessionsOptions = {},
  ) {
    this.spawnPty = options.spawnPty ?? (spawnNodePty as PtySpawnFn);
    this.killEscalationMs = options.killEscalationMs ?? KILL_ESCALATION_MS;
  }

  create(input: CreateTerminalInput): TerminalSessionWire {
    ensureSpawnHelperExecutable();
    const id = randomUUID();
    const registryKey = `terminal:${id}`;
    if (!this.registry.tryClaim(registryKey)) {
      // tryClaim refuses for two reasons. A fresh UUID colliding with a live
      // claim would be a double-spawn bug (defensive); the one reachable cause
      // is daemon shutdown — report each accurately, mirroring the sibling
      // claim sites' RUN_STOPPING semantics.
      if (this.registry.has(registryKey)) {
        throw new ConflictException(
          'TERMINAL_BUSY',
          `terminal ${id} is already claimed`,
        );
      }
      throw new ConflictException(
        'RUN_STOPPING',
        'daemon shutdown started before the terminal could open',
      );
    }

    let pty: PtyLike;
    try {
      pty = this.spawnPty(input.command, input.args, {
        name: 'xterm-256color',
        cols: clamp(input.cols ?? DEFAULT_COLS, 1, MAX_COLS),
        rows: clamp(input.rows ?? DEFAULT_ROWS, 1, MAX_ROWS),
        cwd: input.cwd,
        env: stringEnv(buildChildEnv({ TERM: 'xterm-256color', ...input.env })),
      });
    } catch (err) {
      this.registry.release(registryKey);
      throw err;
    }

    const session: Session = {
      id,
      kind: 'interactive',
      runId: input.runId,
      nodeId: input.nodeId,
      resumeSessionId: input.resumeSessionId ?? null,
      cwd: input.cwd,
      pty,
      scrollback: new CappedTextBuffer(),
      status: 'running',
      exitCode: null,
      events: new Subject<TerminalEvent>(),
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);

    pty.onData((data) => this.absorb(session, data));

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
      if (session.disposedExplicitly) {
        // The user closed this mirror; nobody re-attaches to replay it.
        this.sessions.delete(id);
      } else {
        // Keep the exited session around briefly so a re-attach can replay
        // the final screen, then evict — without a TTL every abandoned
        // session pins up to SCROLLBACK_CAP of memory for the daemon's
        // lifetime.
        session.evictTimer = setTimeout(() => {
          this.sessions.delete(id);
        }, EXITED_SESSION_TTL_MS);
        session.evictTimer.unref?.();
      }
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

  /**
   * Open a `live` session over a byte stream this service did not spawn.
   *
   * Nothing is claimed in {@link ProcessRegistry} and no child exists: there is
   * no process to reap, and claiming one would make the run look busy for chat
   * turns over a session that runs nothing. The stream ENDING (its run deleted,
   * its buffer evicted) settles the session exactly as a PTY exit does, so an
   * attached client stops wearing a live badge over a dead buffer.
   */
  createMirror(input: CreateMirrorInput): TerminalSessionWire {
    const id = randomUUID();
    const session: Session = {
      id,
      kind: 'live',
      runId: input.runId,
      nodeId: input.nodeId,
      // A live mirror follows the NODE across every turn it runs, so it is not
      // pinned to any one CLI session the way an interactive `--resume` is.
      resumeSessionId: null,
      cwd: input.cwd,
      pty: null,
      scrollback: new CappedTextBuffer(),
      status: 'running',
      exitCode: null,
      events: new Subject<TerminalEvent>(),
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    // Seeded BEFORE subscribing, in the same synchronous tick, so the buffered
    // history and the live appends cannot interleave or double up.
    this.absorb(session, input.snapshot);
    session.mirrorSub = input.source.subscribe({
      next: (data) => this.absorb(session, data),
      complete: () => this.settleMirror(session),
      error: () => this.settleMirror(session),
    });
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
    kind: TerminalKind,
    runId: string,
    nodeId: string | null,
    resumeSessionId: string | null = null,
  ): TerminalSessionWire | null {
    for (const session of this.sessions.values()) {
      if (
        session.kind === kind &&
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
    return this.session(id).scrollback.snapshot();
  }

  /**
   * Live event stream for one session. Attach protocol: read {@link scrollback}
   * and subscribe in the same synchronous tick — PTY events fire on later ticks,
   * so no byte can slip between the snapshot and the subscription.
   */
  stream(id: string): Observable<TerminalEvent> {
    return this.session(id).events.asObservable();
  }

  /**
   * Forward input to the session's process. A `live` session has none — it
   * watches someone else's turn — so this is a silent no-op there rather than a
   * throw: the panel already hides its input affordances, and a stray
   * keystroke racing a session swap must not surface as an error.
   */
  write(id: string, data: string): void {
    const session = this.session(id);
    if (session.pty && session.status === 'running') {
      session.pty.write(data);
    }
  }

  /** No-op for a `live` session: nothing is rendering to a fixed grid. */
  resize(id: string, cols: number, rows: number): void {
    const session = this.session(id);
    if (session.pty && session.status === 'running') {
      session.pty.resize(clamp(cols, 1, MAX_COLS), clamp(rows, 1, MAX_ROWS));
    }
  }

  /**
   * Kill every live session mirroring one run, and report how many there were.
   *
   * Matched by FIELD SCAN because sessions are keyed by their own id — the
   * `${runId}:${nodeId}:${sessionId}` composite in `TerminalsService` keys
   * IN-FLIGHT CREATES, not sessions, so it cannot answer "what is open on this
   * run". Used when the run itself is deleted: a mirror of a run that no
   * longer exists would keep a claude child alive against a transcript nothing
   * can read.
   */
  killRun(runId: string): number {
    let killed = 0;
    for (const session of this.sessions.values()) {
      if (session.runId === runId && session.status !== 'exited') {
        this.kill(session.id);
        killed += 1;
      }
    }
    return killed;
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
    if (!session.pty) {
      // A `live` session owns no process, so there is nothing to signal and
      // nothing to escalate against — settling it IS the kill. Guarded here
      // rather than at the call sites so the group-SIGKILL below can never be
      // reached with no pid to aim at.
      this.settleMirror(session);
      return;
    }
    // Captured now: `pty` is nullable on the session, and the escalation below
    // runs in a later tick where that narrowing no longer holds.
    const pty = session.pty;
    try {
      pty.kill();
    } catch {
      // Already gone — the exit handler settles the session.
    }
    if (!session.killTimer) {
      session.killTimer = setTimeout(() => {
        if (session.status !== 'exited') {
          killProcessGroup(pty.pid, 'SIGKILL', () =>
            process.kill(pty.pid, 'SIGKILL'),
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
    if (!session.pty) {
      // A `live` session is forgotten at once: the `closing` limbo below exists
      // to stop a reopen racing a second `--resume` onto one CLI session, and a
      // mirror spawns nothing there could be a second of. Its SOURCE keeps
      // buffering for the run either way — closing the panel must not cost the
      // next mirror the history it would have replayed.
      this.settleMirror(session);
      // `settleMirror` arms the replay TTL for an ABANDONED mirror; this one is
      // being deleted right now, so the timer would hold the session (and its
      // scrollback) for half an hour to delete a key that is already gone.
      if (session.evictTimer) {
        clearTimeout(session.evictTimer);
      }
      this.sessions.delete(id);
      return;
    }
    if (session.status === 'running') {
      this.kill(id);
      session.status = 'closing';
      session.disposedExplicitly = true;
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

  /**
   * Buffer one chunk into a session's scrollback and fan it out. Shared by the
   * PTY's `onData` and the mirror's source subscription so the two cannot
   * diverge on the emit order (buffer first, THEN publish — a subscriber that
   * immediately re-reads the scrollback must see the chunk it was just handed).
   * The retention rule itself is {@link CappedTextBuffer}, shared with the live
   * mirror's own buffer so the two cannot drift on the cap.
   */
  private absorb(session: Session, data: string): void {
    if (!session.scrollback.push(data)) {
      return;
    }
    session.events.next({ kind: 'data', data });
  }

  /**
   * End a `live` session: its source is gone (run deleted, buffer evicted) or
   * the user closed it. Idempotent — the source completing and an explicit
   * dispose can both land, and a second `exit` event would tell an attached
   * client the mirror ended twice.
   */
  private settleMirror(session: Session): void {
    if (session.status === 'exited') {
      return;
    }
    session.mirrorSub?.unsubscribe();
    session.mirrorSub = undefined;
    session.status = 'exited';
    // Null, not 0: nothing exited. A code would claim a process outcome for a
    // session that never had a process.
    session.exitCode = null;
    session.events.next({ kind: 'exit', exitCode: null });
    session.events.complete();
    // Same TTL as an exited PTY: the final screen stays re-attachable for a
    // while, then goes. Without it a settled mirror would pin up to
    // SCROLLBACK_CAP for the daemon's whole life — and unlike a PTY, whose
    // exit is a user closing a REPL, a mirror settles whenever its run is
    // deleted, which is a routine event.
    if (!session.evictTimer) {
      session.evictTimer = setTimeout(() => {
        this.sessions.delete(session.id);
      }, EXITED_SESSION_TTL_MS);
      session.evictTimer.unref?.();
    }
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new NotFoundException(
        'TERMINAL_NOT_FOUND',
        `no terminal session: ${id}`,
      );
    }
    return session;
  }

  private toWire(session: Session): TerminalSessionWire {
    return {
      id: session.id,
      kind: session.kind,
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
