import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import type {
  AgentEvent,
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type {
  BetweenTurnApproval,
  CliSessionOptions,
} from '../utils/spawn-cli';

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
  private readonly closeListeners = new Set<(runId: string) => void>();

  /**
   * Told whenever a run's process is closed — the one signal that no further
   * event of any kind is coming from it.
   *
   * It exists because an off-turn `running` ends only on a terminal event, and
   * closing the process that owed that event strands the badge for ever (see
   * `ChatService.settleAfterSessionClosed`). Nothing here interprets that; the
   * registry's job is to say the process is gone.
   *
   * NOT fired during shutdown: every session is closed on the way out, the
   * daemon is seconds from exiting, and a listener writing rows into a
   * database that is closing behind it can only lose. The next boot's
   * reconcile owns those runs instead.
   */
  onClosed(listener: (runId: string) => void): void {
    this.closeListeners.add(listener);
  }

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
    /**
     * How a request the posture will not decide reaches the USER with no turn
     * in flight — see `CliSessionOptions.onHeldApproval`. Bound at spawn like
     * the event sink above and for the same reason: it files the card under the
     * RUN, which does not change from turn to turn.
     */
    onHeldApproval?: CliSessionOptions['onHeldApproval'],
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
      // Wrapped so an off-turn row RESTARTS the idle clock — see
      // {@link touchOffTurn}. Only when the caller supplied a sink: passing a
      // function where it passed none would change what `startSession` is told
      // about this session, and the re-arm has nothing to observe anyway.
      onBetweenTurnEvent:
        onBetweenTurnEvent === undefined
          ? undefined
          : (event) => {
              this.touchOffTurn(runId);
              onBetweenTurnEvent(event);
            },
      onHeldApproval,
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
   * This run's live process, or null when it holds none.
   *
   * Handed OUT rather than questioned here, because what to ask it is the
   * adapter's business and not this registry's — and because the answer to
   * "what is in the window" does not always need a process at all (cursor
   * reads its own store off disk). Callers must not hold on to it: it is
   * reaped by the idle window and by eviction.
   *
   * Deliberately does NOT touch `lastUsedAt`. Reading what a session is doing
   * is not using it, and refreshing the clock here would let an open readout
   * keep an abandoned chat's CLI — and its MCP servers — alive indefinitely.
   */
  peek(runId: string): AgentSession | null {
    const entry = this.entries.get(runId);
    return entry && entry.session.alive ? entry.session : null;
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

  /**
   * The CLI produced a row with no turn of ours open — restart the idle clock.
   *
   * `session.idle` means "alive with no turn of OURS in flight", which is
   * exactly true of a CLI running flat out between turns: a delegate reporting
   * back, a continuation the agent opened for itself. Without this the window
   * armed at the last settle simply runs out underneath live work — measured on
   * run 1fb3a9f5, a session reaped three seconds after its last row, thirty
   * minutes of continuous off-turn output having touched nothing here.
   *
   * Refreshes rather than arms, and only when a window is already running: with
   * a turn in flight there is deliberately no timer (`disarm`), and `track`
   * arms the next one when that turn settles.
   */
  private touchOffTurn(runId: string): void {
    const entry = this.entries.get(runId);
    if (!entry?.timer) {
      return;
    }
    entry.lastUsedAt = Date.now();
    entry.timer.refresh();
  }

  private arm(runId: string, entry: SessionEntry): void {
    this.disarm(entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.entries.get(runId) !== entry || !entry.session.idle) {
        return;
      }
      if (entry.session.parked) {
        // The window measures a chat going UNUSED, and this one is not: the CLI
        // is standing still on a question the user has been shown and has not
        // answered. Closing it here is how a real run was lost — the CLI read
        // the close as a refusal of the question, wrote "the user doesn't want
        // to proceed", and the run was marked failed 22 minutes after anyone
        // had touched it.
        //
        // Re-armed rather than abandoned: the wait ends when they answer, and
        // nothing else would restart the clock before the next turn. So an
        // answered card leaves the session with at most one more full window,
        // and one never answered costs a process the user still has open — the
        // same bound an in-turn card already has, where Stop is the only end.
        this.arm(runId, entry);
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
        // `parked` alongside `idle`, not folded into it: a session holding a
        // card the user is looking at is idle in the only sense `idle` claims
        // (no turn in flight) and busy in the sense that matters here. Evicting
        // it kills the question rather than the process — the CLI takes the
        // close as a refusal, and the user's answer arrives at nothing.
        if (!candidate[1].session.idle || candidate[1].session.parked) {
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
    if (this.shuttingDown) {
      return;
    }
    for (const listener of this.closeListeners) {
      try {
        listener(runId);
      } catch (err) {
        // One listener's failure must not stop the others, and must never stop
        // a close: this runs inside `evictIfFull` and the teardown path, where
        // throwing would leave a process the registry has already forgotten.
        this.logger.warn(
          `a session-close listener for run ${runId} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
