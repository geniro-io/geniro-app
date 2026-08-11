import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import type {
  AgentEvent,
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { BetweenTurnApproval } from '../utils/spawn-cli';

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
  /**
   * The between-turn approval policy, in a holder the session reads THROUGH.
   *
   * The session is opened once and lives for the whole run, but the policy is
   * built per turn (it closes over that turn's approval mode). Handing the
   * spawn a bare closure therefore froze the posture at turn 1: a chat started
   * in `auto` and switched to `ask` went on auto-approving between-turn
   * permissions for the rest of the session, with no card — the same silent
   * wrong verdict this whole change exists to end, inverted. The holder is
   * what lets every later turn — including the ones served off the reuse path,
   * which never reach a spawn at all — replace it.
   */
  policy: { current: BetweenTurnApproval | undefined };
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
    /**
     * This turn's answer for a request that arrives after it settles — see
     * {@link BetweenTurnApproval}.
     *
     * Supplied per TURN even though the session is per RUN, and installed on
     * every call (spawn and reuse alike) so the posture a between-turn request
     * is judged by is the one the user most recently chose.
     */
    betweenTurnApproval?: BetweenTurnApproval | undefined,
    /**
     * Where a NON-approval event arriving between turns goes — see
     * `CliSessionOptions.onBetweenTurnEvent`. Bound at spawn and not per turn,
     * because unlike the posture it carries no turn state: it files the event
     * under the RUN, which is the same run for every turn on this session.
     */
    onBetweenTurnEvent?: (event: AgentEvent) => void,
  ): AgentTurnHandle {
    const existing = this.entries.get(runId);
    if (existing) {
      this.disarm(existing);
      // Before the turn opens, not after: this turn's posture is what a
      // request arriving after it settles must be judged by, and the reuse
      // path is the ONLY path most turns take.
      existing.policy.current = betweenTurnApproval;
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

    const policy: SessionEntry['policy'] = { current: betweenTurnApproval };
    const session = adapter.startSession(input, {
      // A daemon that is shutting down must not keep a process alive past the
      // drain: `close()` would have to arrive from a hook that has already run.
      runScoped: !this.shuttingDown,
      // Read THROUGH the holder on every request, so the posture is the one
      // the most recent turn declared rather than the one this spawn saw.
      // Only installed when this caller has a posture at all — a session with
      // no policy must keep `spawn-cli`'s own default (hold a question, refuse
      // a permission), which an always-present indirection would erase.
      betweenTurnApproval:
        betweenTurnApproval === undefined
          ? undefined
          : // A later turn that supplies none falls back to HOLDING rather
            // than to the refuse default — between the two, the direction that
            // cannot grant something unasked is the one to fail toward.
            (request) => policy.current?.(request) ?? null,
      onBetweenTurnEvent,
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
      policy,
    };
    this.entries.set(runId, entry);
    this.forgetWhenClosed(runId, entry);
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

  /**
   * Drop an entry the moment its process dies, rather than waiting for someone
   * to try to use it.
   *
   * A dead session reports `idle === false` — it is not "alive with no turn in
   * flight" — and every reader here treats a non-idle entry as BUSY. So the
   * idle timer returns without closing it, and `evictIfFull` skips it while
   * still counting it against the ceiling. The consequence is inverted: a
   * genuinely live idle session gets chosen as `oldest` and closed instead,
   * respawning that run's CLI and re-booting the user's MCP servers — the exact
   * cost this whole feature exists to avoid.
   *
   * `closed` is the channel the session already exposes for this
   * (`CliSession.closed`), so nothing new had to be plumbed; it simply had no
   * subscriber on this side.
   */
  private forgetWhenClosed(runId: string, entry: SessionEntry): void {
    void entry.session.closed.then(() => {
      // Only if it is still the registered one: a replaced entry's `closed`
      // arrives after its successor is in the map, and deleting then would
      // drop a live session.
      if (this.entries.get(runId) !== entry) {
        return;
      }
      this.disarm(entry);
      this.entries.delete(runId);
    });
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
    // A dead session is not busy, whatever `idle` says about it. Dropping these
    // first is what stops one from occupying a slot forever and getting a LIVE
    // session evicted in its place — `closed` normally removes them, but a
    // process killed behind the registry's back (the cancel fallback's group
    // kill) may not have settled yet when the next turn arrives.
    for (const [runId, entry] of [...this.entries]) {
      if (!entry.session.alive) {
        this.closeEntry(runId, entry, 'its process was already gone');
      } else if (entry.session.retired) {
        // Alive, idle, and unable to serve a turn — the state a cancelled (or
        // deadline-ended) turn leaves behind. It has to be dropped HERE and not
        // merely skipped: its `lastUsedAt` was just refreshed, so it is the
        // NEWEST entry, and the loop below would keep it and close a genuinely
        // reusable session instead — re-booting that run's MCP servers to make
        // room for a process nothing can use.
        this.closeEntry(runId, entry, 'it can no longer serve a turn');
      }
    }
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
