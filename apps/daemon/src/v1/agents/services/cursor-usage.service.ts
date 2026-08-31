import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

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
export class CursorUsageService {
  private readonly logger = new Logger(CursorUsageService.name);

  /** When the last poll ATTEMPT started — the floor is on attempts, not wins. */
  private lastAttemptAtMs = 0;
  /** The end of the last SUCCESSFUL window, which the next one resumes from. */
  private lastSuccessMs: number | null = null;
  /** The poll in flight, so concurrent callers join it rather than duplicate it. */
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly runDao: RunDao,
    private readonly nodeStates: NodeStateDao,
    private readonly em: EntityManager,
  ) {}

  /**
   * Bring every cursor run's cost up to date, if enough time has passed.
   *
   * Returns without touching the network in the common case. `force` is for the
   * one caller that is a deliberate user action (a Stats refresh), and even that
   * cannot start a second concurrent poll.
   */
  async refresh(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastAttemptAtMs < MIN_POLL_INTERVAL_MS) {
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
      await this.writeSpend(conversations, spend, em);
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
  ): Promise<Map<string, string>> {
    const byConversation = new Map<string, string>();
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
          byConversation.set(sessionId, row.id);
        }
      }
    }
    return byConversation;
  }

  /**
   * The team and user ids the events are scoped by, from the CLI's OWN identity
   * block. Read rather than invented, and absent identity is a clean decline.
   */
  private async readIdentity(): Promise<{
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
  private async readToken(): Promise<string | null> {
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
   * Write each conversation's total onto the run that holds it.
   *
   * REPLACES rather than adds, which is what makes the overlapping window safe:
   * the fold is over the whole window every time, so an event re-read on the
   * next poll cannot be counted twice. A run whose conversation the window did
   * not mention is left exactly as it was — silence about a period says nothing
   * about a total already recorded for it.
   */
  private async writeSpend(
    conversations: ReadonlyMap<string, string>,
    spend: ReadonlyMap<string, CursorConversationSpend>,
    em: EntityManager,
  ): Promise<void> {
    for (const [conversationId, runId] of conversations) {
      const one = spend.get(conversationId);
      if (one === undefined || one.events === 0) {
        continue;
      }
      await this.runDao.updateById(
        runId,
        {
          cursorCostCents: one.costCents,
          cursorCostEvents: one.events,
        },
        em,
      );
    }
  }
}
