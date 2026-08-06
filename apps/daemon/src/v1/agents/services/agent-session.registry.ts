import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import type {
  AgentEvent,
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';

/**
 * How long a run's CLI process is kept after its last turn.
 *
 * The whole cost/benefit of a run-scoped process sits on this number. Too
 * short and the user's MCP servers — and a browser one of them owns — are
 * rebooted while they are still reading the last answer, which is the very
 * complaint this exists to fix. Too long and an abandoned chat holds a CLI and
 * every server it started for hours.
 *
 * Thirty minutes: long enough to cover reading a long answer, switching to
 * another window and coming back; short enough that walking away for the
 * afternoon does not. The daemon's own idle exit (10 min with no connected
 * client) reaps everything sooner whenever the app is simply closed, so this
 * only governs a session the user still has open.
 */
export const SESSION_IDLE_MS = 30 * 60_000;

/**
 * How many run-scoped processes may live at once.
 *
 * A CLI holding ten MCP servers is a few hundred megabytes, so this is a real
 * ceiling and not a formality: without it, opening a dozen chats would keep a
 * dozen of them. Eviction takes the least-recently-used IDLE session — never
 * one with a turn in flight, which would kill work the user is watching.
 */
export const MAX_LIVE_SESSIONS = 3;

interface SessionEntry {
  session: AgentSession;
  /** When this run's last turn ended; drives both eviction and expiry. */
  lastUsedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The CLI process each chat run keeps between its turns.
 *
 * A coding CLI boots the user's MCP servers when it starts, and an MCP server
 * can own something expensive — a browser they are logged into. Spawning one
 * process per turn therefore tore that down on every message; measured on
 * claude 2.1.223, two messages meant two full boots of all ten servers and
 * 6.5s of startup before the second turn produced a token. Held across the run
 * it is one boot and 0.5s.
 *
 * **This registry is the owner of those processes.** Nothing else reaps one:
 * a run-scoped CLI has no reason of its own to exit, so every path out — the
 * idle window, the eviction, a delete, daemon shutdown — goes through
 * {@link close} here.
 *
 * Deliberately separate from `ProcessRegistry`, which tracks TURNS (claim,
 * cancel, shutdown drain). The two lifetimes genuinely differ now: a turn ends
 * while its process keeps running, and folding them into one map would make
 * "is this run busy" and "does this run hold a process" the same question when
 * they are no longer the same question.
 */
@Injectable()
export class AgentSessionRegistry implements OnApplicationShutdown {
  private readonly logger = new Logger(AgentSessionRegistry.name);
  private readonly entries = new Map<string, SessionEntry>();
  private shuttingDown = false;

  /**
   * Start a turn for this run, reusing its process when one fits and spawning
   * a fresh session when none does.
   *
   * The reuse decision is the ADAPTER's: a session refuses a turn it cannot
   * serve (different argv, dead process, a CLI that hosts one turn per
   * process) and this simply takes the refusal as "spawn a new one". So
   * nothing here knows which CLI it is talking to.
   */
  startTurn(
    runId: string,
    adapter: AgentAdapter,
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): AgentTurnHandle {
    const existing = this.entries.get(runId);
    if (existing) {
      this.disarm(existing);
      const handle = existing.session.startTurn(input, onEvent);
      if (handle) {
        return this.track(runId, existing, handle);
      }
      // It could not serve this turn, and a session that has refused one will
      // not serve the next either — the reasons are all sticky (dead process,
      // changed argv, one-turn CLI). Replace it rather than keeping a process
      // nothing can use.
      this.closeEntry(runId, existing, 'it could not serve the next turn');
    }

    // Evict BEFORE spawning, so the ceiling counts what will exist rather than
    // what did.
    this.evictIfFull();

    const session = adapter.startSession(input, {
      // A daemon that is shutting down must not keep a process alive past the
      // drain: `close()` would have to arrive from a hook that has already run.
      runScoped: !this.shuttingDown,
    });
    const handle = session.startTurn(input, onEvent);
    if (!handle) {
      // A freshly opened session always accepts its first turn — a spawn
      // failure comes back as a settled handle carrying an `error` event. This
      // is a broken adapter contract, not a runtime condition.
      session.close();
      throw new Error(`agent session for run ${runId} refused its first turn`);
    }
    const entry: SessionEntry = {
      session,
      lastUsedAt: Date.now(),
      timer: null,
    };
    this.entries.set(runId, entry);
    return this.track(runId, entry, handle);
  }

  /**
   * Close the run's process, if it still holds one. Idempotent, so every
   * teardown path can call it without first asking whether there is one.
   */
  close(runId: string): void {
    const entry = this.entries.get(runId);
    if (entry) {
      this.closeEntry(runId, entry, 'its run was torn down');
    }
  }

  /** Runs currently holding a process — for diagnostics and the specs. */
  get liveCount(): number {
    return this.entries.size;
  }

  /**
   * Close every process on the way out.
   *
   * `ProcessRegistry` cancels the in-flight TURNS and drains them; this ends
   * the processes those turns were running on, which nothing else would. The
   * two hooks are independent and both idempotent, so their order does not
   * matter — which is the point, since Nest does not promise one.
   */
  onApplicationShutdown(): void {
    this.shuttingDown = true;
    for (const [runId, entry] of [...this.entries]) {
      this.closeEntry(runId, entry, 'the daemon is shutting down');
    }
  }

  /** Re-arm the idle window once this turn settles. */
  private track(
    runId: string,
    entry: SessionEntry,
    handle: AgentTurnHandle,
  ): AgentTurnHandle {
    void handle.done.then(() => {
      // Only for the entry still registered under this run: a session replaced
      // while the old turn was settling must not re-arm a timer over its
      // successor.
      if (this.entries.get(runId) !== entry) {
        return;
      }
      entry.lastUsedAt = Date.now();
      this.arm(runId, entry);
    });
    return handle;
  }

  private arm(runId: string, entry: SessionEntry): void {
    this.disarm(entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.entries.get(runId) !== entry || !entry.session.idle) {
        return;
      }
      this.closeEntry(runId, entry, 'it went unused');
    }, SESSION_IDLE_MS);
    entry.timer.unref?.();
  }

  private disarm(entry: SessionEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /**
   * Make room for one more process by closing the least-recently-used IDLE
   * session. A session with a turn in flight is never evicted — that would
   * kill work the user is watching to make room for work they just asked for.
   */
  private evictIfFull(): void {
    while (this.entries.size >= MAX_LIVE_SESSIONS) {
      let oldest: [string, SessionEntry] | null = null;
      for (const candidate of this.entries) {
        if (!candidate[1].session.idle) {
          continue;
        }
        if (oldest === null || candidate[1].lastUsedAt < oldest[1].lastUsedAt) {
          oldest = candidate;
        }
      }
      if (oldest === null) {
        // Every session is busy. Going over the ceiling is the lesser harm:
        // the alternative is refusing a turn the user asked for, or killing
        // one that is running.
        this.logger.warn(
          `all ${this.entries.size} agent sessions are busy — starting another over the ${MAX_LIVE_SESSIONS} ceiling`,
        );
        return;
      }
      this.closeEntry(oldest[0], oldest[1], 'the session ceiling was reached');
    }
  }

  private closeEntry(runId: string, entry: SessionEntry, reason: string): void {
    this.disarm(entry);
    this.entries.delete(runId);
    try {
      entry.session.close();
    } catch (err) {
      // One session that cannot be closed must not stop the others — this runs
      // in a loop on shutdown, where giving up would orphan every later
      // process.
      this.logger.warn(
        `failed to close the agent session for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.logger.log(`closed the agent session for run ${runId} — ${reason}`);
  }
}
