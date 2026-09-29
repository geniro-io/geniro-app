import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import type { AccountSpendConversation } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { pollsSpendFor } from '../utils/polled-spend';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';

/**
 * The floor on how often this service asks an account, whatever asks it to.
 *
 * This is the whole cadence design and it is deliberate: a per-message or
 * per-thread fetch would put one request on a vendor's server for every turn
 * every user of this app runs — and an account endpoint answers for the whole
 * ACCOUNT over a date range, so ONE call already covers every conversation
 * geniro holds. Cursor's own guidance for the documented sibling of its
 * endpoint is to poll at most hourly; ten minutes is well inside that while
 * still feeling live to somebody watching a thread's price settle.
 */
const MIN_POLL_INTERVAL_MS = 10 * 60_000;

/**
 * The floor while a polled conversation is actually PRODUCING.
 *
 * Ten minutes is right for an ambient trigger — somebody opened a thread, so
 * its figure may as well be current. It is wrong for the thread being watched:
 * an account bills per REQUEST rather than at a turn's end, so the figure moves
 * while a turn is in flight.
 *
 * Bounded by the work rather than by a timer: the tick comes from items a
 * polled conversation persisted, so an idle machine polls nothing and a user
 * of self-pricing CLIs only polls nothing ever.
 */
const LIVE_POLL_INTERVAL_MS = 60_000;

/**
 * How far back a poll looks past the last one it completed. A charge is
 * written when it is billed, not the instant the turn ended, so a window
 * starting exactly where the last one stopped would drop whatever landed late.
 * The per-conversation watermark is what keeps the overlap from being counted
 * twice.
 */
const POLL_OVERLAP_MS = 60 * 60_000;

/**
 * The widest window a first poll asks for. Asking for an account's whole
 * history would be the one heavy request this design exists to avoid; seven
 * days covers the conversations a user is plausibly still looking at.
 */
const FIRST_POLL_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/**
 * The four columns a poll reads of a run. It writes runs only through
 * `nativeUpdate`, so the rows are read-only projections and stay out of the
 * identity map.
 */
const RUN_READ = {
  fields: ['id', 'agentKind', 'polledCostCents', 'polledCostEvents'],
  disableIdentityMap: true,
} as const;

/**
 * A run as a poll holds it. Typed to the projection, so reading a column
 * {@link RUN_READ} leaves out is a compile error rather than an `undefined`.
 */
type PolledRun = Pick<Run, (typeof RUN_READ)['fields'][number]>;

/** One polled conversation, the run that holds it, and how far it is priced. */
interface ConversationTarget {
  run: PolledRun;
  /** The `node_state` row carrying this conversation's session id. */
  nodeId: string;
  /** Its watermark, or 0 when the conversation has never been priced. */
  throughMs: number;
}

/** What one poll found that one run has newly spent. */
interface RunDelta {
  run: PolledRun;
  cents: number;
  events: number;
  marks: { nodeId: string; throughMs: number; cents: number; events: number }[];
}

/**
 * What each conversation of a POLLED-spend CLI has cost — a CLI whose turns
 * carry no price (`AdapterConfig.usage.polledSpend`) — fetched in one batched
 * poll per CLI through that adapter's own `fetchAccountSpend`, and written onto
 * the runs and nodes holding those conversations.
 *
 * Every fact about HOW an account is asked lives in the adapter; this service
 * owns only the cadence, the watermarks and the writes. Three properties shape
 * it:
 *
 * - It is **batched and floored**, on TWO floors — {@link MIN_POLL_INTERVAL_MS}
 *   for an ambient caller and {@link LIVE_POLL_INTERVAL_MS} while a polled
 *   conversation is producing items — and never runs two polls at once, so
 *   there is no per-thread or per-message request anywhere.
 * - It **fails closed and silent**: an adapter that cannot read its account
 *   answers null, which ends as "no cost reported". A missing price is never an
 *   error strip.
 * - It **accumulates**: each conversation's watermark on `node_state` marks the
 *   newest charge already counted, so the overlapping window adds only what is
 *   new and a long thread's total never ticks downward.
 */
@Injectable()
export class PolledSpendService implements OnModuleInit {
  private readonly logger = new Logger(PolledSpendService.name);

  /** When the last poll ATTEMPT started — the floor is on attempts, not wins. */
  private lastAttemptAtMs = 0;
  /**
   * The end of each CLI's last SUCCESSFUL window, which its next one resumes
   * from. Per CLI, so one account that could not be read does not advance
   * another's window past charges it never saw.
   */
  private readonly lastSuccessMs = new Map<AgentKind, number>();
  /** The poll in flight, so concurrent callers join it rather than duplicate it. */
  private inFlight: Promise<void> | null = null;
  /**
   * Which rows belong to a polled CLI, keyed `<runId>\0<nodeId>`, so the live
   * tick costs one indexed read per row and not one per item. A run's (and a
   * node's) agent is fixed once known, so this caches a FACT; entries are
   * dropped with their run.
   */
  private readonly polledRows = new Map<string, boolean>();

  constructor(
    private readonly runDao: RunDao,
    private readonly nodeStates: NodeStateDao,
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  /**
   * Follow the work, which is the only thing that moves these figures — every
   * item rather than the turn-ending ones, since an account bills per request
   * and a long turn accrues cost throughout. A bus subscriber, so no turn path
   * has to remember to call this.
   */
  onModuleInit(): void {
    this.bus.all().subscribe((event) => {
      void this.noteItem(event.runId, event.item.nodeId);
    });
    this.bus.allDeleted().subscribe((runId) => {
      const prefix = `${runId}\u0000`;
      for (const key of [...this.polledRows.keys()]) {
        if (key.startsWith(prefix)) {
          this.polledRows.delete(key);
        }
      }
    });
  }

  /** Whether a CLI's money is polled from its account rather than read off a turn. */
  pollsSpend(agentKind: string | null): boolean {
    return pollsSpendFor(this.adapters.all(), agentKind);
  }

  /**
   * Whether a run holds any polled conversation — the chat's own agent, or a
   * polled-CLI node in a workflow. What a readout asks before it nudges a poll.
   */
  async runHoldsPolledSpend(
    runId: string,
    agentKind: string | null,
  ): Promise<boolean> {
    if (this.pollsSpend(agentKind)) {
      return true;
    }
    try {
      const states = await this.nodeStates.listByRun(runId, this.em.fork());
      return states.some((state) => this.pollsSpend(state.agentKind));
    } catch {
      return false;
    }
  }

  /**
   * Bring every polled conversation's cost up to date, if enough time has
   * passed. `force` is for the one caller that is a deliberate user action (a
   * Stats refresh), and even that cannot start a second concurrent poll.
   */
  async refresh(force = false): Promise<void> {
    return this.refreshWithin(force ? 0 : MIN_POLL_INTERVAL_MS);
  }

  private async noteItem(runId: string, nodeId: string | null): Promise<void> {
    if (Date.now() - this.lastAttemptAtMs < LIVE_POLL_INTERVAL_MS) {
      return;
    }
    if (!(await this.isPolledRow(runId, nodeId))) {
      return;
    }
    await this.refreshWithin(LIVE_POLL_INTERVAL_MS);
  }

  /**
   * Whether a row came from a polled CLI — the run's own agent for a chat, the
   * NODE's for a workflow, whose run names no agent because its agents are per
   * node.
   */
  private async isPolledRow(
    runId: string,
    nodeId: string | null,
  ): Promise<boolean> {
    const key = `${runId}\u0000${nodeId ?? ''}`;
    const known = this.polledRows.get(key);
    if (known !== undefined) {
      return known;
    }
    try {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      // A run that could not be read is NOT filed: the next item asks again,
      // where caching the miss would exempt that conversation for good.
      if (run === null) {
        return false;
      }
      if (run.workflowId === null || nodeId === null) {
        const polled = this.pollsSpend(run.agentKind);
        this.polledRows.set(key, polled);
        return polled;
      }
      const state = await this.nodeStates.getByRunNode(runId, nodeId, em);
      const kind = state?.agentKind ?? null;
      // Filed only once the node KNOWS its agent: a pending node's row carries
      // none yet, and filing that as "not polled" would exempt it for good.
      if (kind !== null) {
        this.polledRows.set(key, this.pollsSpend(kind));
      }
      return this.pollsSpend(kind);
    } catch {
      return false;
    }
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
    for (const [kind, adapter] of this.adapters.all()) {
      if (!adapter.getConfig().usage.polledSpend) {
        continue;
      }
      await this.pollOne(kind, adapter, now);
    }
  }

  private async pollOne(
    kind: AgentKind,
    adapter: AgentAdapter,
    now: number,
  ): Promise<void> {
    try {
      const em = this.em.fork();
      // Ask nothing at all unless this machine holds a conversation of this
      // CLI: a user who never ran it must never see its credential prompt, and
      // an account with no runs here has nothing to attribute.
      const conversations = await this.conversationsFor(kind, em);
      if (conversations.size === 0) {
        return;
      }
      const lastSuccess = this.lastSuccessMs.get(kind);
      const since = new Map<string, number>();
      for (const [conversationId, target] of conversations) {
        since.set(conversationId, target.throughMs);
      }
      const spend = await adapter.fetchAccountSpend({
        startMs:
          lastSuccess === undefined
            ? now - FIRST_POLL_LOOKBACK_MS
            : lastSuccess - POLL_OVERLAP_MS,
        endMs: now,
        since,
      });
      if (spend === null) {
        return;
      }
      await this.writeSpend(conversations, spend, em, now);
      this.lastSuccessMs.set(kind, now);
    } catch (error) {
      // Swallowed on the `github-prs` rule: a thread missing its price is a
      // far smaller cost than a listing or a settle failing over a readout.
      this.logger.warn(
        `could not refresh ${kind} account usage: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Which run holds which conversation of this CLI, and how far each has been
   * priced. The join is the session id `node_state` already records, which is
   * what the account calls the conversation — so nothing new is stored to make
   * the attribution exact.
   *
   * Runs whose OWN agent is this CLI (a 1:1 chat) PLUS runs merely holding a
   * node that ran on it — every workflow routing work to it, whose run row
   * names no agent at all.
   */
  private async conversationsFor(
    kind: AgentKind,
    em: EntityManager,
  ): Promise<Map<string, ConversationTarget>> {
    const byConversation = new Map<string, ConversationTarget>();
    const runIds = new Set(await this.nodeStates.runIdsForAgent(kind, em));
    const runs = await this.runDao.getAll({ agentKind: kind }, RUN_READ, em);
    for (const row of runs) {
      runIds.delete(row.id);
    }
    const withNodes =
      runIds.size === 0
        ? []
        : await this.runDao.getAll({ id: { $in: [...runIds] } }, RUN_READ, em);
    for (const row of [...runs, ...withNodes]) {
      for (const state of await this.nodeStates.listByRun(row.id, em)) {
        // A workflow's node on another CLI holds a session id from THAT CLI's
        // store, which this account has never heard of — never offer it.
        if (row.agentKind !== kind && state.agentKind !== kind) {
          continue;
        }
        const sessionId = state.agentSessionId;
        if (sessionId !== null && sessionId !== '') {
          byConversation.set(sessionId, {
            run: row,
            nodeId: state.nodeId,
            throughMs: state.polledSpendThroughMs ?? 0,
          });
        }
      }
    }
    return byConversation;
  }

  /**
   * Add what is NEW to each run's and node's total, advance the watermarks,
   * and TELL every window what changed.
   *
   * The watermarks advance BEFORE the totals are written: nothing here is
   * transactional, so a failure between the two either drops a slice that was
   * counted (this order) or counts one twice (the other), and a thread
   * reporting slightly less than it spent is the safe direction for a figure a
   * user checks against their own bill.
   *
   * The announce is what makes a new price visible in a thread that is already
   * open — a `run_status` with `status: null`, since this says what the run has
   * SPENT and nothing about whether it is still going, and only for a run whose
   * figure actually moved.
   */
  private async writeSpend(
    conversations: ReadonlyMap<string, ConversationTarget>,
    spend: ReadonlyMap<string, AccountSpendConversation>,
    em: EntityManager,
    at: number,
  ): Promise<void> {
    const byRun = new Map<string, RunDelta>();
    for (const [conversationId, target] of conversations) {
      const one = spend.get(conversationId);
      if (one === undefined || one.events === 0) {
        continue;
      }
      const entry = byRun.get(target.run.id) ?? {
        run: target.run,
        cents: 0,
        events: 0,
        marks: [],
      };
      entry.cents += one.costCents;
      entry.events += one.events;
      // A conversation whose counted charges carried no readable time is
      // watermarked at the POLL's own end: left unmarked it would be counted
      // again on every later poll, a total that never stops growing.
      entry.marks.push({
        nodeId: target.nodeId,
        throughMs: one.latestAtMs > 0 ? one.latestAtMs : at,
        cents: one.costCents,
        events: one.events,
      });
      byRun.set(target.run.id, entry);
    }
    for (const { run, cents, events, marks } of byRun.values()) {
      for (const mark of marks) {
        await this.nodeStates.rememberPolledSpendThrough(
          run.id,
          mark.nodeId,
          mark.throughMs,
          em,
        );
        await this.nodeStates.addPolledSpend(
          run.id,
          mark.nodeId,
          { cents: mark.cents, events: mark.events },
          em,
        );
      }
      const nextCents = (run.polledCostCents ?? 0) + cents;
      const nextEvents = (run.polledCostEvents ?? 0) + events;
      await this.runDao.updateWithoutActivity(
        run.id,
        { polledCostCents: nextCents, polledCostEvents: nextEvents },
        em,
      );
      run.polledCostCents = nextCents;
      run.polledCostEvents = nextEvents;
      this.bus.publishRunStatus({
        runId: run.id,
        status: null,
        spendUpdatedAt: at,
      });
    }
  }
}
