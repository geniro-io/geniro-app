import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';
import { spawn as spawnNodePty } from 'node-pty';
import { Observable, Subject } from 'rxjs';

import type { AgentTurnHandle } from '../../agents/adapters/adapter.types';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { CappedTextBuffer } from '../../agents/utils/capped-text-buffer';
import { buildChildEnv } from '../../agents/utils/child-env';
import { killProcessGroup } from '../../agents/utils/kill-tree';
import {
  MAX_COLS,
  MAX_ROWS,
  type TerminalEvent,
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
 * How long a replacement child must go quiet before its screen is taken as
 * fully rendered and swapped in.
 *
 * Probe-measured on a 200KB transcript: `claude --resume` emits its first byte
 * at ~780ms and stops at ~3.0s. The window only has to outlast the gaps WITHIN
 * that render, not the render itself, so it is short.
 */
// Exported so specs drive the real window rather than a copy of it.
export const REFRESH_QUIET_MS = 600;
/**
 * Give up waiting for a replacement to go quiet and swap in what it has drawn.
 * A CLI that never stops emitting (an animation, a spinner) would otherwise
 * hold the swap open forever and freeze the mirror for good.
 */
const REFRESH_RENDER_TIMEOUT_MS = 20_000;
/**
 * The cadence of the DURING-a-turn re-read.
 *
 * Probe-measured: the CLI appends to its transcript as the turn runs (a 34s
 * turn grew 11 → 15 → 16 → 19 → 20 → 22 → 25 lines), so re-reading mid-turn
 * genuinely shows new work — the mirror does not have to wait for the turn to
 * end. The interval is what keeps that affordable: each re-read is a whole CLI
 * process booting and re-rendering the conversation, so it runs on a cadence
 * rather than per transcript item, and only while somebody is attached.
 */
export const LIVE_REFRESH_INTERVAL_MS = 10_000;
/**
 * How long an automatic refresh stays out of the way after the user types.
 *
 * A re-spawn is a NEW CLI process: whatever was half-typed at the prompt is
 * gone with the old one. Someone typing into the mirror has taken the
 * conversation over by hand, and stealing their line to show them an update
 * they can see in the chat pane anyway is the worse trade.
 */
export const REFRESH_INPUT_GRACE_MS = 30_000;

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
  refreshQuietMs?: number;
  liveRefreshIntervalMs?: number;
  refreshInputGraceMs?: number;
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

/** One terminal session: the PTY child, its retained output, its lifecycle. */
interface Session {
  id: string;
  runId: string;
  nodeId: string | null;
  resumeSessionId: string | null;
  cwd: string;
  /** Buffered output replayed to a (re)attaching client, newest-wins. */
  scrollback: CappedTextBuffer;
  status: TerminalStatus;
  exitCode: number | null;
  events: Subject<TerminalEvent>;
  createdAt: number;
  /** How long an exited session's final screen stays re-attachable. */
  evictTimer?: NodeJS.Timeout;
  /** The CURRENT child. Replaced in place by {@link TerminalSessionsService.refresh}. */
  pty: PtyLike;
  /**
   * Everything needed to spawn the child AGAIN, kept because a refresh is
   * literally a re-spawn of the same invocation: the CLI reads its transcript
   * once at startup, so re-reading it means starting over.
   */
  spawn: SpawnSpec;
  killTimer?: NodeJS.Timeout;
  /**
   * A replacement child rendering off-screen, waiting to take over. Also the
   * re-entrancy guard — a workflow settling five nodes at once, or a turn
   * emitting five items, must not stack five respawns onto one mirror.
   */
  pending?: PendingRefresh;
  /** When the last refresh STARTED — the throttle's clock. */
  lastRefreshAt: number;
  /** A refresh the throttle deferred rather than dropped. */
  trailingTimer?: NodeJS.Timeout;
  /** When the user last typed into this mirror; 0 if never. */
  lastInputAt: number;
  /** Resolves when the session settles FOR GOOD — never on a refresh. */
  settle: () => void;
  /**
   * Set by {@link TerminalSessionsService.dispose} on a running session: the user closed
   * this mirror on purpose, so on exit it is forgotten immediately instead of
   * held (scrollback and all) for the abandoned-session replay TTL.
   */
  disposedExplicitly?: boolean;
}

/**
 * A replacement child rendering OFF-SCREEN while the current one stays on the
 * user's terminal.
 *
 * The whole point of buffering rather than swapping immediately: a re-read is a
 * cold CLI start — probe-measured at ~780ms to first byte and ~3.0s to a
 * finished screen on a 200KB transcript. Clearing the terminal at the START of
 * that gave the user three seconds of blank followed by a redraw, which is what
 * made the mirror feel broken. Held here, the swap is a single repaint of an
 * already-complete screen.
 */
interface PendingRefresh {
  pty: PtyLike;
  /** What the replacement has drawn so far, replayed in one write on commit. */
  buffer: string[];
  /** Fires once the replacement has been quiet long enough to be done. */
  quietTimer?: NodeJS.Timeout;
  /** Backstop for a replacement that never goes quiet. */
  deadline?: NodeJS.Timeout;
  /** Set once this refresh has committed or been discarded — stops buffering. */
  done: boolean;
}

/** The invocation a session spawns, and re-spawns on every refresh. */
interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

/**
 * Wipe the screen AND the scrollback, then home the cursor.
 *
 * Sent to attached clients immediately before a refresh's replacement child
 * starts writing. Without it the resumed TUI's fresh render lands UNDER the
 * previous one and the user reads the conversation twice, the stale copy first.
 * `3J` is the xterm extension that clears the saved lines too, which is the
 * half that matters here — `2J` alone leaves the old transcript one scroll away.
 */
const CLEAR_SCREEN = '\u001b[2J\u001b[3J\u001b[H';

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
 * Owns every terminal-mirror session: a `--resume` CLI child under a PTY,
 * bridged raw to xterm.js.
 *
 * Named for SESSIONS rather than for PTYs because a session OUTLIVES its
 * child. {@link refresh} replaces the process in place — same session id, same
 * event stream, same attached clients — which is what keeps the mirror in step
 * with the chat: the CLI reads its transcript once at startup and never again,
 * so the only way a second process learns what the chat has since said is to be
 * started over.
 *
 * Spawn is env-stripped via {@link buildChildEnv}, and every PTY child
 * registers with {@link ProcessRegistry} under `terminal:<id>` — the prefix
 * keeps a mirror from marking its run "busy" for chat turns — so cancel and
 * daemon shutdown reap it like any other spawned child. ONE registry entry
 * covers a session for its whole life, whichever child is current, so a
 * refreshed session can never leave an unmanaged process behind. Sessions are
 * in-memory only: a mirror is not history, so nothing touches SQLite.
 */
@Injectable()
export class TerminalSessionsService {
  private readonly logger = new Logger(TerminalSessionsService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly spawnPty: PtySpawnFn;
  private readonly killEscalationMs: number;
  private readonly refreshQuietMs: number;
  private readonly liveRefreshIntervalMs: number;
  private readonly refreshInputGraceMs: number;

  constructor(
    private readonly registry: ProcessRegistry,
    options: TerminalSessionsOptions = {},
  ) {
    this.spawnPty = options.spawnPty ?? (spawnNodePty as PtySpawnFn);
    this.killEscalationMs = options.killEscalationMs ?? KILL_ESCALATION_MS;
    this.refreshQuietMs = options.refreshQuietMs ?? REFRESH_QUIET_MS;
    this.liveRefreshIntervalMs =
      options.liveRefreshIntervalMs ?? LIVE_REFRESH_INTERVAL_MS;
    this.refreshInputGraceMs =
      options.refreshInputGraceMs ?? REFRESH_INPUT_GRACE_MS;
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

    const spawn: SpawnSpec = {
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      cols: clamp(input.cols ?? DEFAULT_COLS, 1, MAX_COLS),
      rows: clamp(input.rows ?? DEFAULT_ROWS, 1, MAX_ROWS),
      env: stringEnv(buildChildEnv({ TERM: 'xterm-256color', ...input.env })),
    };
    let pty: PtyLike;
    try {
      pty = this.spawnChild(spawn);
    } catch (err) {
      this.registry.release(registryKey);
      throw err;
    }

    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const session: Session = {
      id,
      runId: input.runId,
      nodeId: input.nodeId,
      resumeSessionId: input.resumeSessionId ?? null,
      cwd: input.cwd,
      pty,
      spawn,
      settle,
      scrollback: new CappedTextBuffer(),
      status: 'running',
      exitCode: null,
      events: new Subject<TerminalEvent>(),
      createdAt: Date.now(),
      lastRefreshAt: Date.now(),
      lastInputAt: 0,
    };
    this.sessions.set(id, session);
    this.wire(session);

    const handle: AgentTurnHandle = {
      done,
      cancel: () => this.kill(id),
      respondApproval: () => false,
    };
    this.registry.register(registryKey, handle);
    return this.toWire(session);
  }

  /**
   * Re-read the conversation: start the same invocation again and swap it in
   * once it has finished drawing.
   *
   * The whole reason the mirror needed fixing. `claude --resume` loads the
   * transcript ONCE, at startup — probe-measured: with a headless turn running
   * on the same session, an already-open TUI grew by exactly 0 bytes — so a
   * mirror opened before a turn shows the conversation as it was when the panel
   * opened, forever. Re-spawning is the only mechanism the CLI offers.
   *
   * Everything the client holds survives: session id, event stream, attachment.
   * The replacement renders OFF-SCREEN (see {@link PendingRefresh}) and the
   * user's terminal changes exactly once, when there is a complete new screen
   * to show.
   *
   * `immediate` skips the throttle — the caller knows the transcript is final
   * (the turn settled) rather than merely further along. A throttled call is
   * also gated on somebody being attached; both back off entirely while the
   * user is typing into the mirror.
   *
   * Silently does nothing for a session that is not running, or one already
   * refreshing — a workflow settling several nodes at once must not stack
   * respawns onto one mirror.
   */
  refresh(id: string, options: { immediate?: boolean } = {}): void {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'running' || session.pending) {
      return;
    }
    const now = Date.now();
    // A re-spawn discards whatever the user has half-typed, so an automatic
    // one backs off entirely while they are working in the mirror by hand.
    if (now - session.lastInputAt < this.refreshInputGraceMs) {
      return;
    }
    if (!options.immediate) {
      // Nobody is looking: a re-read would burn a CLI start to update a screen
      // no client is subscribed to. The turn's settle refresh is `immediate`,
      // so an unattended mirror still ends up correct for a later attach.
      if (!session.events.observed) {
        return;
      }
      const since = now - session.lastRefreshAt;
      if (since < this.liveRefreshIntervalMs) {
        // Deferred, not dropped: the item that arrived inside the interval is
        // often the last one before a long tool call, and dropping it outright
        // would leave the mirror stale for the whole of it.
        if (!session.trailingTimer) {
          session.trailingTimer = setTimeout(() => {
            session.trailingTimer = undefined;
            this.refresh(id);
          }, this.liveRefreshIntervalMs - since);
          session.trailingTimer.unref?.();
        }
        return;
      }
    }
    this.startRefresh(session);
  }

  /**
   * Refresh every mirror of one (run, node) — that conversation's transcript
   * has grown, so what the mirrors are showing is behind.
   *
   * Matched by FIELD SCAN for the same reason {@link killRun} is: sessions are
   * keyed by their own id. A node can have several mirrors (one per call
   * thread) and all of them are looking at the same conversation file, so all
   * of them are equally stale.
   */
  refreshTarget(
    runId: string,
    nodeId: string | null,
    options: { immediate?: boolean } = {},
  ): void {
    for (const session of this.sessions.values()) {
      if (session.runId === runId && session.nodeId === nodeId) {
        this.refresh(session.id, options);
      }
    }
  }

  /**
   * Start a replacement child, off-screen. The current one keeps the user's
   * terminal until {@link commitRefresh} has a finished screen to swap in.
   *
   * A spawn failure LEAVES THE SESSION ALONE. The mirror the user is looking at
   * still works — it is merely out of date — so failing to build its successor
   * is not a reason to take it away.
   */
  private startRefresh(session: Session): void {
    session.lastRefreshAt = Date.now();
    let next: PtyLike;
    try {
      next = this.spawnChild(session.spawn);
    } catch (err) {
      this.logger.warn(
        `terminal ${session.id} could not be refreshed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const pending: PendingRefresh = { pty: next, buffer: [], done: false };
    session.pending = pending;
    next.onData((data) => {
      if (pending.done) {
        return;
      }
      pending.buffer.push(data);
      if (pending.quietTimer) {
        clearTimeout(pending.quietTimer);
      }
      pending.quietTimer = setTimeout(
        () => this.commitRefresh(session, pending),
        this.refreshQuietMs,
      );
      pending.quietTimer.unref?.();
    });
    next.onExit(() => {
      if (pending.done) {
        return;
      }
      // The replacement died before it could take over. Keep the child that
      // works: a stale mirror beats a dead one.
      this.logger.warn(
        `terminal ${session.id}: the refreshed CLI exited before it rendered`,
      );
      this.endRefresh(session, pending);
    });
    pending.deadline = setTimeout(
      () => this.commitRefresh(session, pending),
      REFRESH_RENDER_TIMEOUT_MS,
    );
    pending.deadline.unref?.();
  }

  /**
   * Swap the finished replacement onto the user's terminal in ONE repaint, then
   * retire the child it replaces.
   *
   * Order matters: `session.pty` moves to the replacement BEFORE the old child
   * is signalled, so the old child's exit lands on the `session.pty !== pty`
   * guard in {@link wire} and settles nothing.
   */
  private commitRefresh(session: Session, pending: PendingRefresh): void {
    if (session.pending !== pending || pending.done) {
      return;
    }
    if (pending.buffer.length === 0) {
      // Nothing was drawn — the deadline fired on a child that never spoke.
      // Committing would replace a readable screen with an empty one.
      this.logger.warn(
        `terminal ${session.id}: the refreshed CLI drew nothing; keeping the current screen`,
      );
      this.endRefresh(session, pending);
      return;
    }
    this.endRefresh(session, pending, { keepChild: true });
    const previous = session.pty;
    session.pty = pending.pty;
    // The replacement rendered the whole conversation from the top, so the
    // client's screen and the replay buffer both start over — otherwise the
    // transcript would appear twice, the stale copy first.
    session.scrollback = new CappedTextBuffer();
    // ONE write, not a clear followed by a render: they cross the socket as
    // separate frames otherwise, and the client paints the blank between them.
    this.absorb(session, CLEAR_SCREEN + pending.buffer.join(''));
    this.wire(session);
    this.retireChild(previous);
  }

  /**
   * Tear down a pending refresh's timers and detach it from the session,
   * killing its child unless it is being promoted.
   */
  private endRefresh(
    session: Session,
    pending: PendingRefresh,
    options: { keepChild?: boolean } = {},
  ): void {
    pending.done = true;
    if (pending.quietTimer) {
      clearTimeout(pending.quietTimer);
      pending.quietTimer = undefined;
    }
    if (pending.deadline) {
      clearTimeout(pending.deadline);
      pending.deadline = undefined;
    }
    if (session.pending === pending) {
      session.pending = undefined;
    }
    if (!options.keepChild) {
      this.retireChild(pending.pty);
    }
  }

  /**
   * Kill one child that is no longer a session's current process — the one a
   * refresh replaced, or a replacement that will never be shown.
   *
   * Separate from {@link signal} because that one targets `session.pty` and
   * arms the session's own escalation timer; a retired child is by definition
   * not that, and both can be in flight at once.
   */
  private retireChild(pty: PtyLike): void {
    let exited = false;
    pty.onExit(() => {
      exited = true;
    });
    try {
      pty.kill();
    } catch {
      return; // Already gone.
    }
    const timer = setTimeout(() => {
      if (exited) {
        return;
      }
      killProcessGroup(pty.pid, 'SIGKILL', () =>
        process.kill(pty.pid, 'SIGKILL'),
      );
    }, this.killEscalationMs);
    timer.unref?.();
  }

  /** Spawn one child of a session's invocation. */
  private spawnChild(spec: SpawnSpec): PtyLike {
    return this.spawnPty(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
    });
  }

  /**
   * Subscribe to the session's CURRENT child. Called for the first spawn and
   * again for each refresh's replacement, so the two cannot drift on what a
   * child's data and exit mean.
   */
  private wire(session: Session): void {
    const { pty } = session;
    pty.onData((data) => this.absorb(session, data));
    pty.onExit(({ exitCode }) => {
      if (session.killTimer) {
        clearTimeout(session.killTimer);
        session.killTimer = undefined;
      }
      // Guard on the CHILD: a refresh promotes its replacement to `session.pty`
      // before signalling the one it replaces, so the retired child's exit
      // arrives here for a session that has already moved on and must settle
      // nothing.
      if (session.pty !== pty) {
        return;
      }
      this.discardPending(session);
      session.status = 'exited';
      session.exitCode = exitCode;
      session.events.next({ kind: 'exit', exitCode });
      session.events.complete();
      if (session.disposedExplicitly) {
        // The user closed this mirror; nobody re-attaches to replay it.
        this.sessions.delete(session.id);
      } else {
        // Keep the exited session around briefly so a re-attach can replay
        // the final screen, then evict — without a TTL every abandoned
        // session pins up to SCROLLBACK_CAP of memory for the daemon's
        // lifetime.
        session.evictTimer = setTimeout(() => {
          this.sessions.delete(session.id);
        }, EXITED_SESSION_TTL_MS);
        session.evictTimer.unref?.();
      }
      session.settle();
    });
  }

  /**
   * Abandon any refresh in flight and any refresh the throttle deferred.
   *
   * Called wherever a session stops being refreshable — it exited, or the user
   * killed it. The replacement child is NOT covered by its own registry claim
   * (the session's one claim covers whichever children it has), so leaving one
   * running here is exactly the unmanaged child the process-registry rule
   * exists to prevent.
   */
  private discardPending(session: Session): void {
    if (session.trailingTimer) {
      clearTimeout(session.trailingTimer);
      session.trailingTimer = undefined;
    }
    if (session.pending) {
      this.endRefresh(session, session.pending);
    }
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
   * Forward input to the session's process. A silent no-op once the session is
   * no longer running — a stray keystroke racing an exit (or the brief gap
   * while a refresh swaps children) must not surface to the user as an error.
   */
  write(id: string, data: string, options: { typed?: boolean } = {}): void {
    const session = this.session(id);
    if (session.status === 'running') {
      // `typed` — a HUMAN pressed a key — is the only thing that pauses the
      // automatic re-read, and it can only be known at the client. A terminal
      // emulator answers the TUI's own queries down this same channel: claude's
      // TUI emits `ESC[c` (Device Attributes) on every render and xterm.js
      // replies without anyone touching a key. Treating that as typing re-armed
      // the grace on every render, so the mirror never refreshed again — the
      // "still no sync" regression. Anything the client does not vouch for is
      // NOT typing, so an unrecognised reply can only cost a lost keystroke's
      // grace, never the refresh itself.
      if (options.typed) {
        session.lastInputAt = Date.now();
      }
      session.pty.write(data);
    }
  }

  /**
   * Resize the session's grid. The new size is REMEMBERED on the spawn spec,
   * not just pushed to the current child: a refresh spawns the replacement at
   * the size the user's panel actually is, rather than back at 80×24.
   */
  resize(id: string, cols: number, rows: number): void {
    const session = this.session(id);
    const safeCols = clamp(cols, 1, MAX_COLS);
    const safeRows = clamp(rows, 1, MAX_ROWS);
    session.spawn.cols = safeCols;
    session.spawn.rows = safeRows;
    if (session.status === 'running') {
      session.pty.resize(safeCols, safeRows);
      // The replacement is rendering at the OLD grid and is about to become
      // what the user sees; leaving it unresized would swap in a screen wrapped
      // for a width the panel no longer has.
      session.pending?.pty.resize(safeCols, safeRows);
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
    // A kill OUTRANKS a refresh: a replacement rendering off-screen is a child
    // of a mirror the user just closed, and promoting it would resurrect the
    // CLI they meant to stop.
    this.discardPending(session);
    this.signal(session);
  }

  /**
   * Send the polite kill and arm the group-SIGKILL escalation for the session's
   * CURRENT child — the mechanism shared by {@link kill} and {@link refresh},
   * which differ only in what the resulting exit means.
   */
  private signal(session: Session): void {
    const { pty } = session;
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
   * PTY's `onData` and the refresh's screen clear so the two cannot diverge on
   * the emit order (buffer first, THEN publish — a subscriber that immediately
   * re-reads the scrollback must see the chunk it was just handed).
   */
  private absorb(session: Session, data: string): void {
    if (!session.scrollback.push(data)) {
      return;
    }
    session.events.next({ kind: 'data', data });
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
