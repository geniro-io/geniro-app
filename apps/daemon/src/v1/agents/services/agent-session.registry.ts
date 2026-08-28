import { totalmem } from 'node:os';

import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';

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
 * THREE HOURS, raised from thirty minutes on request. Thirty covered reading a
 * long answer and coming back from another window; it did not cover the way
 * these threads are actually used — left open across a meeting or an afternoon
 * and returned to — and the cost of getting that wrong is asymmetric. A window
 * that is too long reaps an abandoned chat late; one that is too short reboots
 * the user's MCP servers, and a browser one of them owns, in front of someone
 * who was still working in that thread.
 *
 * What it changes is WHICH mechanism does the reaping, not whether anything
 * does — and neither of the other two moved:
 *
 * - The daemon's own idle exit (10 min with no connected client) still takes
 *   everything the moment the app is closed, so this only ever governs a
 *   session whose window the user still has open.
 * - {@link MAX_LIVE_SESSIONS} still caps how many are held at once, derived
 *   from this machine's memory at ~1GB each. Past three hours that ceiling is
 *   what closes the oldest IDLE session rather than the clock — which is the
 *   better order anyway: it reclaims the process the user is least likely to
 *   come back to, at the moment the memory is actually wanted, instead of on a
 *   timer that cannot see whether anything needs the room.
 */
export const SESSION_IDLE_MS = 3 * 60 * 60_000;

/**
 * What one kept CLI process costs in memory.
 *
 * MEASURED 2026-08-25 on the author's own machine, over the four claude
 * sessions the daemon was holding: 1202MB, 1129MB, 905MB, 897MB — mean
 * ~1.01GB. That is the HEAVY case and deliberately so, since it is the one the
 * ceiling exists for: a CLI with ten MCP servers dialled, which is what a
 * working chat looks like here. A CLI with none is a fraction of it, so this
 * over-estimates in the safe direction.
 */
export const SESSION_MEMORY_COST_BYTES = 1024 ** 3;

/**
 * How much of the machine's memory the kept sessions may claim between them.
 *
 * An eighth. Not a number anybody can derive — what it encodes is that these
 * processes are a CACHE (every one of them can be closed and re-opened with
 * `--resume`, costing latency and nothing else), so they get a slice rather
 * than a share of what is free: the user's editor, browser and the agents'
 * own subprocesses have the rest, and none of them announce themselves here.
 */
const SESSION_MEMORY_SHARE = 1 / 8;

/**
 * The floor. Below two there is no point keeping any: the benefit is a chat
 * staying warm while you work in another one, and at one the second chat
 * evicts the first every time you switch.
 */
const MIN_LIVE_SESSIONS = 2;

/**
 * The cap, and it is not about memory — a 512GB machine would compute 64.
 * Past about a dozen the constraint stops being the hardware and starts being
 * the person: those are conversations somebody is meant to be following, and a
 * ceiling that scales without bound is not a ceiling. The idle window reaps
 * what is genuinely abandoned either way.
 */
const MAX_LIVE_SESSIONS_CAP = 16;

/**
 * How many run-scoped processes may live at once, for a machine of this size.
 *
 * A CLI holding ten MCP servers is about a gigabyte, so this is a real ceiling
 * and not a formality: without it, opening a dozen chats would keep a dozen of
 * them. It was a flat `3`, which is the whole reason it is now computed — three
 * is right for a 16GB laptop and absurd on the 128GB machine this was reported
 * from, where it meant paying a cold start (~6.5s and every MCP server
 * rebooted) on the fourth chat while 110GB sat free. REPORTED as "что за max
 * live session… это очень мало!", and the answer asked for was to derive it
 * rather than pick a better constant.
 *
 * Derived from TOTAL memory, never from what is free right now: free memory
 * depends on what the machine happened to be doing when the daemon booted, so
 * the same computer would get a different ceiling on each launch and no
 * behaviour here would be reproducible. Memory is also the only axis — cores
 * do not bound how many idle processes may sit in RAM.
 *
 * Pure and exported so it is testable at sizes this machine is not: see the
 * spec, which pins the curve rather than whatever the test host happens to
 * have.
 */
export function sessionCeilingFor(totalMemoryBytes: number): number {
  const affordable = Math.floor(
    (totalMemoryBytes * SESSION_MEMORY_SHARE) / SESSION_MEMORY_COST_BYTES,
  );
  return Math.min(
    MAX_LIVE_SESSIONS_CAP,
    Math.max(MIN_LIVE_SESSIONS, affordable),
  );
}

/** The ceiling this daemon runs under — {@link sessionCeilingFor} of this box. */
export const MAX_LIVE_SESSIONS = sessionCeilingFor(totalmem());

/**
 * How long after its last off-turn row a session is still treated as WORKING.
 *
 * `session.idle` means "no turn of OURS in flight", which is also true of a CLI
 * running flat out between turns — a delegate reporting back, a continuation
 * the agent opened for itself. {@link touchOffTurn} already had to teach the
 * idle WINDOW that difference; eviction never learned it, and the two are the
 * same fact used for two decisions.
 *
 * What that cost is measured, on the reporter's own run `309e0822` (2026-08-25,
 * reconstructed from `geniro.db` and the debug log): a claude thread ran on
 * after its turn settled, wrote its twelve-task plan, said "Starting T1", and
 * its last row landed at 13:16:09 — one second before `evictIfFull` picked it
 * as the least-recently-used idle session and closed the process. The chat then
 * sat for 22 minutes reading `completed` with 11 of 12 tasks pending, until the
 * user typed "status?" to restart it. REPORTED as "Тред сам по себе остановился
 * … я должен писать ему какое-то сообщение, чтобы он продолжил".
 *
 * Five minutes, the same span and the same reasoning as `ChatService`'s
 * `DELEGATE_ROW_LEASE_MS`: it is the answer to "how long do we go on believing
 * a quiet stretch is still work", and two different answers to one question is
 * how the badge and the process come to disagree about whether a chat is busy.
 *
 * It can only ever push the registry OVER the ceiling, never refuse a turn —
 * `evictIfFull` already has that arm, for the case where every session is busy,
 * and this widens what counts as busy rather than adding a new outcome.
 */
export const OFF_TURN_ACTIVE_MS = 5 * 60_000;

interface SessionEntry {
  session: AgentSession;
  /**
   * The agent and folder this process was spawned for.
   *
   * Recorded solely so {@link AgentSessionRegistry.markStale} can find the
   * sessions an MCP change is ABOUT. The registry is keyed by run, and a
   * change to a folder's servers is about every run working in that folder —
   * a fact neither the run id nor the session itself carries.
   */
  agent: string;
  cwd: string;
  /**
   * Why this process can no longer serve a turn, or null.
   *
   * Set when something outside the run changed what a fresh process would
   * load — today, that folder's MCP servers. The session is NOT closed on the
   * spot, which is the whole design: closing it would either kill a turn that
   * is running or reap a dozen idle chats nobody is about to use. The flag is
   * read at the start of the next turn, which is exactly the moment the change
   * has to have landed.
   */
  stale: string | null;
  /** When this run's last turn ended; drives both eviction and expiry. */
  lastUsedAt: number;
  /**
   * When the CLI last produced a row with no turn of ours open, or 0 for a
   * session that has never done so.
   *
   * Separate from {@link lastUsedAt}, which both this and a settling turn
   * refresh: the two mean different things to eviction. A session whose turn
   * ended a moment ago is merely RECENT, and evicting it costs a respawn; one
   * writing rows this second is WORKING, and evicting it costs the work. Only
   * the second is exempt, so a busy chat is not confused with a fresh one.
   */
  offTurnActiveAt: number;
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
  private readonly closeListeners = new Set<
    (runId: string, interrupted: boolean) => void
  >();
  /** See {@link onIdleFarewell} — one listener, not a set: it is a question put
   *  to the process, and the close waits for it. */
  private farewell: ((runId: string) => Promise<void>) | null = null;

  /**
   * This registry's ceiling, defaulting to what the machine affords.
   *
   * A constructor argument purely as a TEST SEAM — the specs pin a fixed value
   * so the eviction cases mean the same thing on a 16GB CI box and on a 128GB
   * desktop, where the computed ceiling differs by a factor of eight. `@Optional`
   * is what lets Nest instantiate this with no provider for `Number`.
   */
  private readonly ceiling: number;

  constructor(@Optional() ceiling?: number) {
    this.ceiling = ceiling ?? MAX_LIVE_SESSIONS;
  }

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
   *
   * `interrupted` says whether the process was still WORKING when it was
   * closed ({@link worksOffTurn}) — the difference between housekeeping and
   * cutting a running agent off, which the listener cannot see from here and
   * which decides whether the transcript owes the user a sentence.
   */
  onClosed(listener: (runId: string, interrupted: boolean) => void): void {
    this.closeListeners.add(listener);
  }

  /**
   * The LAST moment this run's process can be asked anything — awaited before
   * an unused session is closed.
   *
   * It exists because some readings only a RUNNING agent can give are wanted
   * long after it stops running: claude answers the context breakdown and the
   * plan limits on its live stdin dialogue alone, so a chat whose process has
   * been reaped has nothing to show until the user spends a turn reviving it.
   * Asking on the way out costs one round trip on a process that is about to be
   * thrown away, and it is asked at the one close that leaves a conversation
   * the user will come back to.
   *
   * ONLY the idle close. An eviction wants the memory back now, a staleness
   * replacement has a turn waiting behind it, a delete is discarding the run,
   * and shutdown is seconds from ending the process anyway — none of them can
   * afford a second of politeness, and all four leave the reading absent, which
   * the readout already has a sentence for.
   *
   * The listener is handed the run id and nothing else: the session is still in
   * the map while it runs, so {@link peek} is how it reaches the process, and
   * this hook stays free of the session type.
   */
  onIdleFarewell(listener: (runId: string) => Promise<void>): void {
    this.farewell = listener;
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
    if (existing?.stale !== null && existing !== undefined) {
      // Replaced rather than reused, and replaced HERE rather than when the
      // change landed: the process holds MCP servers it read at spawn, so a
      // turn served by it would run against the configuration the user just
      // left. The conversation survives — cursor re-`session/load`s it off
      // disk and claude resumes by id — so the cost is one respawn.
      this.closeEntry(runId, existing, existing.stale);
    } else if (existing) {
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
      agent: adapter.getConfig().kind,
      cwd: input.cwd,
      stale: null,
      lastUsedAt: Date.now(),
      offTurnActiveAt: 0,
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

  /**
   * Retire every session of one agent in one folder, from the next turn on.
   *
   * REPORTED against cursor as "usually when I update MCP they are available
   * from the very next turn; here it did not see they were updated" — with the
   * agent itself writing, in the transcript, "MCP tools in this session — still
   * only GitHub, Playwright and codegraph; no Linear connector appeared… the
   * connector may need the session restarted". It had diagnosed its own
   * process: a CLI reads its MCP configuration once, when it starts, and geniro
   * keeps that process alive across turns, so a server switched on or signed in
   * to reached the config and never reached the running agent.
   *
   * A MARK rather than a close, for two reasons that both matter. A session may
   * be mid-turn, and closing it there kills work the user asked for. And a
   * folder may hold a dozen idle chats, none of which is about to be used —
   * closing them all would re-spawn a dozen CLIs, each re-launching the user's
   * own MCP servers, to serve turns nobody sent. The next turn on each session
   * is both the correct moment and the only one that costs anything.
   *
   * Answers how many it marked, which is what makes the caller's log worth
   * reading: zero is the ordinary case (a change made with no chat open in that
   * folder) and is not a failure.
   */
  markStale(agent: string, cwd: string, reason: string): number {
    let marked = 0;
    for (const entry of this.entries.values()) {
      if (entry.agent !== agent || entry.cwd !== cwd || entry.stale !== null) {
        continue;
      }
      entry.stale = reason;
      marked += 1;
    }
    return marked;
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
    entry.offTurnActiveAt = entry.lastUsedAt;
    entry.timer.refresh();
  }

  /**
   * Is this session carrying on by ITSELF — working, with no turn of ours open?
   *
   * The third thing eviction must not take, beside a turn in flight and a
   * parked question. See {@link OFF_TURN_ACTIVE_MS} for the run this was
   * measured on.
   */
  private worksOffTurn(entry: SessionEntry): boolean {
    return (
      entry.offTurnActiveAt > 0 &&
      Date.now() - entry.offTurnActiveAt < OFF_TURN_ACTIVE_MS
    );
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
      void this.closeAfterFarewell(runId, entry);
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
   * Make room for one more process by closing the least-recently-used session
   * that is not DOING anything. A session with a turn in flight, one parked on
   * a question, and one carrying on by itself between turns are all exempt —
   * evicting any of them kills work the user is watching to make room for work
   * they just asked for.
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
    while (this.entries.size >= this.ceiling) {
      let oldest: [string, SessionEntry] | null = null;
      for (const candidate of this.entries) {
        // `parked` alongside `idle`, not folded into it: a session holding a
        // card the user is looking at is idle in the only sense `idle` claims
        // (no turn in flight) and busy in the sense that matters here. Evicting
        // it kills the question rather than the process — the CLI takes the
        // close as a refusal, and the user's answer arrives at nothing.
        // `worksOffTurn` alongside the two: a CLI writing rows between turns is
        // idle in the only sense `idle` claims and busy in the sense that
        // matters here, exactly as `parked` is. Reported as a thread that
        // "остановился и ничего не делает" — see {@link OFF_TURN_ACTIVE_MS}.
        if (
          !candidate[1].session.idle ||
          candidate[1].session.parked ||
          this.worksOffTurn(candidate[1])
        ) {
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
          `all ${this.entries.size} agent sessions are busy — starting another over the ${this.ceiling} ceiling`,
        );
        return;
      }
      this.closeEntry(oldest[0], oldest[1], 'the session ceiling was reached');
    }
  }

  /**
   * Let {@link onIdleFarewell} have its last word, then close.
   *
   * The entry stays in the map for the duration, which is what lets the
   * listener reach the process through {@link peek} — and is also why the state
   * is RE-CHECKED afterwards: a turn can arrive while the question is in
   * flight, and that turn's session must not be closed under it. Nothing is
   * re-armed in that case because `startTurn` disarmed this timer and the
   * turn's own settle arms the next window.
   */
  private async closeAfterFarewell(
    runId: string,
    entry: SessionEntry,
  ): Promise<void> {
    if (this.farewell) {
      try {
        await this.farewell(runId);
      } catch (err) {
        // A last reading is worth nothing next to the close it precedes: a
        // listener that throws must not leave the process running for ever.
        this.logger.warn(
          `the idle farewell for run ${runId} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (this.entries.get(runId) !== entry || !entry.session.idle) {
      return;
    }
    this.closeEntry(runId, entry, 'it went unused');
  }

  private closeEntry(runId: string, entry: SessionEntry, reason: string): void {
    // Read BEFORE the entry is dropped and the timer disarmed — both are what
    // the answer is computed from.
    const interrupted = this.worksOffTurn(entry);
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
        listener(runId, interrupted);
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
