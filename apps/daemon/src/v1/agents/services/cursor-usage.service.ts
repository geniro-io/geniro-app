import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import {
  CURSOR_API_HOST,
  CURSOR_USAGE_MAX_PAGES,
  CURSOR_USAGE_METHOD,
  type CursorConversationSpend,
  cursorUsageRequestBody,
  cursorUsageTotalCount,
  foldCursorUsagePage,
  mergeCursorSpend,
} from '../utils/cursor-usage';
import { asNumber, asRecord } from '../utils/json-util';
import { AgentEventBus } from './agent-events.bus';

const run = promisify(execFile);

/**
 * The Keychain item cursor-agent stores its own login under. Read, never
 * written and never kept: the value goes straight into one request header and
 * is not held on this object, logged, or persisted anywhere.
 */
const KEYCHAIN_SERVICE = 'cursor-access-token';
const KEYCHAIN_ACCOUNT = 'cursor-user';

/**
 * The floor on how often this service will talk to Cursor, whatever asks it to.
 *
 * This is the whole cadence design and it is deliberate: a per-message or
 * per-thread fetch would put one request on that server for every turn every
 * user of this app runs, which is both rude and pointless — the endpoint answers
 * for the ACCOUNT over a date range, so ONE call already covers every
 * conversation geniro holds. Cursor's own guidance for the documented sibling of
 * this endpoint is to poll at most hourly; ten minutes is well inside that while
 * still feeling live to somebody watching a thread's price settle.
 */
const MIN_POLL_INTERVAL_MS = 10 * 60_000;

/**
 * The floor while a cursor conversation is actually PRODUCING.
 *
 * Ten minutes is the right cadence for an ambient trigger — somebody opened a
 * thread, so its figure may as well be current. It is the wrong one for the
 * thread being watched, and that is what got reported ("i still dont see any
 * costs for cursor chat"). Reconstructed from the reporter's own database: the
 * previous poll ran at 19:09:16, the chat's first billable event was written by
 * Cursor at 19:09:33, and the next poll was not due until 19:19 — so a run
 * costing $4.89 showed no price at all for the whole time anyone was looking at
 * it. Cursor bills per REQUEST rather than at the turn's end, so the figure
 * genuinely does move while a turn is in flight; there was nothing to wait for.
 *
 * It is bounded by the work rather than by a timer: the tick comes from items
 * a CURSOR run persisted, so an idle machine polls nothing at all and a claude
 * user polls nothing ever. The worst case is one request a minute while a
 * cursor agent is working, against turns that cost dollars each — proportionate,
 * and still far inside the hourly guidance {@link MIN_POLL_INTERVAL_MS} cites.
 */
const LIVE_POLL_INTERVAL_MS = 60_000;

/**
 * How far back a poll looks past the last one it completed.
 *
 * An event is written when Cursor bills it, which is not the instant the turn
 * ended, so a window that started exactly where the last one stopped would drop
 * whatever landed late. Re-reading an overlapping hour costs one page and the
 * fold is a REPLACEMENT per conversation, so a re-read event cannot double-count.
 */
const POLL_OVERLAP_MS = 60 * 60_000;

/**
 * The widest window a first poll will ask for.
 *
 * A fresh install has no marker, and asking for an account's whole history would
 * be the one heavy request this design exists to avoid. Seven days covers the
 * conversations a user is plausibly still looking at; anything older keeps the
 * dash, which is the honest reading for a thread nobody re-priced.
 */
const FIRST_POLL_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/** How long the `security` read and each HTTP page may take. */
const KEYCHAIN_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * What each cursor CONVERSATION has cost, fetched in one batched poll and
 * written onto the runs that hold those conversations.
 *
 * The WHY — and the evidence that no local source exists — is in
 * `utils/cursor-usage.ts`. This is the part that owns the credential, the
 * cadence and the writes.
 *
 * Three properties shape it:
 *
 * - It is **batched and floored**. Every caller goes through {@link refresh},
 *   which does nothing at all inside {@link MIN_POLL_INTERVAL_MS} of the last
 *   attempt and never runs two polls at once. One poll updates every cursor
 *   conversation, so there is no per-thread or per-message request anywhere in
 *   this file.
 * - It **fails closed and silent**, exactly as `main/github-prs.ts` does for the
 *   same shape of call: no CLI installed, no Keychain item, a denied prompt, a
 *   signed-out account, no network — every one of them ends as "no cost
 *   reported", which is the reading the header already draws. A missing price is
 *   never an error strip.
 * - It **holds no credential**. The token is read per poll, used for that poll's
 *   requests, and dropped; nothing here stores it and no log line can carry it.
 */
@Injectable()
export class CursorUsageService implements OnModuleInit {
  private readonly logger = new Logger(CursorUsageService.name);

  /** When the last poll ATTEMPT started — the floor is on attempts, not wins. */
  private lastAttemptAtMs = 0;
  /** The end of the last SUCCESSFUL window, which the next one resumes from. */
  private lastSuccessMs: number | null = null;
  /** The poll in flight, so concurrent callers join it rather than duplicate it. */
  private inFlight: Promise<void> | null = null;
  /**
   * Which runs are cursor runs, so the live tick below costs one indexed read
   * per run and not one per item.
   *
   * A run's agent kind is fixed at creation, so this can never go stale in the
   * direction that matters; an entry is dropped when its run is destroyed. It is
   * a cache of a FACT rather than of an answer, which is why nothing expires it.
   */
  private readonly cursorRuns = new Map<string, boolean>();

  constructor(
    private readonly runDao: RunDao,
    private readonly nodeStates: NodeStateDao,
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
  ) {}

  /**
   * Follow the work, which is the only thing that moves these figures.
   *
   * A subscriber rather than a call from the turn path, on
   * `PullRequestCaptureService`'s reasoning exactly: the bus is where both
   * execution paths converge, and nothing in a turn should have to remember to
   * do this. Every item, not the turn-ending ones — Cursor bills per request, so
   * a twenty-minute turn accrues cost throughout and its END is far too late to
   * be the only trigger.
   *
   * The floor is checked BEFORE the run is looked up, so an item on a busy
   * conversation costs one comparison; the lookup that follows is at most one
   * per run for the life of the daemon.
   */
  onModuleInit(): void {
    this.bus.all().subscribe((event) => {
      void this.noteItem(event.runId);
    });
    // A destroyed run can never produce another item, so this is housekeeping
    // rather than correctness — but the map would otherwise hold ids for rows
    // that no longer exist for as long as the daemon runs.
    this.bus.allDeleted().subscribe((runId) => {
      this.cursorRuns.delete(runId);
    });
  }

  private async noteItem(runId: string): Promise<void> {
    if (Date.now() - this.lastAttemptAtMs < LIVE_POLL_INTERVAL_MS) {
      return;
    }
    if (!(await this.isCursorRun(runId))) {
      return;
    }
    await this.refreshWithin(LIVE_POLL_INTERVAL_MS);
  }

  private async isCursorRun(runId: string): Promise<boolean> {
    const known = this.cursorRuns.get(runId);
    if (known !== undefined) {
      return known;
    }
    try {
      const run = await this.runDao.getById(runId, this.em.fork());
      // A run that could not be read is NOT filed: the next item asks again,
      // where caching the miss would exempt that conversation for good.
      if (run === null) {
        return false;
      }
      const isCursor = run.agentKind === AgentKind.CursorAgent;
      this.cursorRuns.set(runId, isCursor);
      return isCursor;
    } catch {
      return false;
    }
  }

  /**
   * Bring every cursor run's cost up to date, if enough time has passed.
   *
   * Returns without touching the network in the common case. `force` is for the
   * one caller that is a deliberate user action (a Stats refresh), and even that
   * cannot start a second concurrent poll.
   */
  async refresh(force = false): Promise<void> {
    return this.refreshWithin(force ? 0 : MIN_POLL_INTERVAL_MS);
  }

  /** The one gate: a floor on attempts, and never two polls at once. */
  private async refreshWithin(floorMs: number): Promise<void> {
    const now = Date.now();
    if (now - this.lastAttemptAtMs < floorMs) {
      return;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.lastAttemptAtMs = now;
    const pending = this.poll(now).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = pending;
    return pending;
  }

  private async poll(now: number): Promise<void> {
    try {
      const em = this.em.fork();
      // Ask nothing at all unless this machine actually holds a cursor chat.
      // A claude-only user must never see a Keychain prompt for a CLI they do
      // not use, and an account with no cursor runs has nothing to attribute.
      const conversations = await this.conversationsByRun(em);
      if (conversations.size === 0) {
        return;
      }
      const identity = await this.readIdentity();
      if (identity === null) {
        return;
      }
      const token = await this.readToken();
      if (token === null) {
        return;
      }
      const startMs =
        this.lastSuccessMs === null
          ? now - FIRST_POLL_LOOKBACK_MS
          : this.lastSuccessMs - POLL_OVERLAP_MS;
      const spend = await this.fetchSpend(token, identity, startMs, now);
      if (spend === null) {
        return;
      }
      await this.writeSpend(conversations, spend, em, now);
      this.lastSuccessMs = now;
    } catch (error) {
      // Swallowed on the `github-prs` rule: a thread missing its price is a far
      // smaller cost than a listing or a settle failing over a readout.
      this.logger.warn(
        `could not refresh cursor usage: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Which run holds which cursor conversation.
   *
   * The join is the ACP session id `node_state` already records, which is the
   * same value Cursor calls `conversationId` — so nothing new has to be stored
   * to make the attribution exact.
   */
  private async conversationsByRun(
    em: EntityManager,
  ): Promise<Map<string, Run>> {
    const byConversation = new Map<string, Run>();
    const runs = await this.runDao.getAll(
      { agentKind: AgentKind.CursorAgent },
      undefined,
      em,
    );
    for (const row of runs) {
      // A chat's single agent writes one `node_state`; taking whichever node
      // carries a session id keeps this free of the sentinel's spelling, which
      // belongs to the executor rather than to a usage read.
      for (const state of await this.nodeStates.listByRun(row.id, em)) {
        const sessionId = state.agentSessionId;
        if (sessionId !== null && sessionId !== '') {
          byConversation.set(sessionId, row);
        }
      }
    }
    return byConversation;
  }

  /**
   * The team and user ids the events are scoped by, from the CLI's OWN identity
   * block. Read rather than invented, and absent identity is a clean decline.
   *
   * `protected`, like {@link readToken} below, purely so a spec can stand in for
   * this MACHINE — the two of them are the whole of what a poll needs from it,
   * and a test that reached the real ones would read the author's own Keychain
   * on macOS and decline on CI. Nothing in the app overrides either.
   */
  protected async readIdentity(): Promise<{
    teamId: number;
    userId: number;
  } | null> {
    try {
      const raw = await readFile(
        join(homedir(), '.cursor', 'cli-config.json'),
        'utf8',
      );
      const auth = asRecord(asRecord(JSON.parse(raw))?.['authInfo']);
      const teamId = asNumber(auth?.['teamId']);
      const userId = asNumber(auth?.['userId']);
      return userId === null ? null : { teamId: teamId ?? 0, userId };
    } catch {
      return null;
    }
  }

  /**
   * The user's own Cursor login, from the Keychain item that CLI wrote.
   *
   * geniro mints nothing here and keeps nothing: this is the same borrowing the
   * `gh` calls do, one step closer in. A denial, a missing item or a machine
   * that is not macOS all answer null, which the caller reads as "no cost".
   */
  protected async readToken(): Promise<string | null> {
    if (process.platform !== 'darwin') {
      return null;
    }
    try {
      const { stdout } = await run(
        'security',
        [
          'find-generic-password',
          '-s',
          KEYCHAIN_SERVICE,
          '-a',
          KEYCHAIN_ACCOUNT,
          '-w',
        ],
        { timeout: KEYCHAIN_TIMEOUT_MS },
      );
      const token = stdout.trim();
      return token === '' ? null : token;
    } catch {
      return null;
    }
  }

  /** Walk the window's pages and fold them into one per-conversation total. */
  private async fetchSpend(
    token: string,
    identity: { teamId: number; userId: number },
    startMs: number,
    endMs: number,
  ): Promise<Map<string, CursorConversationSpend> | null> {
    const spend = new Map<string, CursorConversationSpend>();
    let seen = 0;
    for (let page = 1; page <= CURSOR_USAGE_MAX_PAGES; page += 1) {
      const body = cursorUsageRequestBody({
        ...identity,
        startMs,
        endMs,
        page,
      });
      const reply = await fetch(`${CURSOR_API_HOST}${CURSOR_USAGE_METHOD}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'connect-protocol-version': '1',
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!reply.ok) {
        // A 401 is a signed-out account and a 4xx is a shape this build no
        // longer matches; both are "no cost reported" rather than an error the
        // user is shown, and both stop the walk rather than paging on.
        this.logger.warn(`cursor usage request answered ${reply.status}`);
        return null;
      }
      const payload: unknown = await reply.json();
      const pageFold = foldCursorUsagePage(payload);
      mergeCursorSpend(spend, pageFold);
      const total = cursorUsageTotalCount(payload);
      seen += [...pageFold.values()].reduce((n, one) => n + one.events, 0);
      if (total === null || seen >= total || pageFold.size === 0) {
        break;
      }
    }
    return spend;
  }

  /**
   * Write each run's total, and TELL every window what changed.
   *
   * REPLACES rather than adds, which is what makes the overlapping window safe:
   * the fold is over the whole window every time, so an event re-read on the
   * next poll cannot be counted twice. A run whose conversations the window did
   * not mention is left exactly as it was — silence about a period says nothing
   * about a total already recorded for it.
   *
   * Summed PER RUN before the write, because the map is keyed by conversation
   * and a run can hold more than one: written per conversation, a run's second
   * conversation overwrote the first's figure with its own rather than adding
   * to it, so the thread reported part of what it spent.
   *
   * The ANNOUNCE is what makes any of this visible while a thread is open. The
   * poll is the only thing that learns a cursor price, the header only re-asks
   * when a turn settles, and the two never lined up — so the figure this write
   * produced was first shown by whatever refetched NEXT, typically the following
   * turn or a reopen. It is a `run_status` for the same reason
   * `PullRequestCaptureService` announces on one: a fact settled a moment after
   * the client last asked, on a broadcast every window already receives.
   * `status: null` on the same rule as every announce beside it — this says what
   * the run has SPENT and nothing about whether it is still going. Only for a
   * run whose figure actually MOVED: a poll covers every cursor conversation the
   * machine holds, so announcing them all would put an event per thread on the
   * wire every minute to say that nothing had changed.
   */
  private async writeSpend(
    conversations: ReadonlyMap<string, Run>,
    spend: ReadonlyMap<string, CursorConversationSpend>,
    em: EntityManager,
    at: number,
  ): Promise<void> {
    const byRun = new Map<
      string,
      { run: Run; cents: number; events: number }
    >();
    for (const [conversationId, run] of conversations) {
      const one = spend.get(conversationId);
      if (one === undefined || one.events === 0) {
        continue;
      }
      const known = byRun.get(run.id);
      byRun.set(run.id, {
        run,
        cents: (known?.cents ?? 0) + one.costCents,
        events: (known?.events ?? 0) + one.events,
      });
    }
    for (const { run, cents, events } of byRun.values()) {
      if (run.cursorCostCents === cents && run.cursorCostEvents === events) {
        continue;
      }
      await this.runDao.updateById(
        run.id,
        { cursorCostCents: cents, cursorCostEvents: events },
        em,
      );
      run.cursorCostCents = cents;
      run.cursorCostEvents = events;
      this.bus.publishRunStatus({
        runId: run.id,
        status: null,
        spendUpdatedAt: at,
      });
    }
  }
}
