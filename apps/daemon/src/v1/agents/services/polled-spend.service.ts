import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import type { AccountSpendEvent } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { readNodeSessions } from '../utils/node-sessions';
import { pollsSpendFor } from '../utils/polled-spend';
import {
  type ConversationSpend,
  conversationSpend,
  readSpendLedger,
  restateConversation,
  writeSpendLedger,
} from '../utils/spend-ledger';
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
 * How far back every poll re-reads past the previous one, and so how long an
 * event's charge is still taken as able to change.
 *
 * Cursor creates an event when a request starts and raises its charge until
 * the request ends — a long agentic request runs for many minutes, and a
 * sub-agent's for longer. An event is re-read at its current amount on every
 * poll whose window still contains it, and settled at its last reading once it
 * falls out (`utils/spend-ledger.ts`), so this is the one bound on how late a
 * charge can still move and be seen. A day is far past any request measured,
 * and costs an ordinary poll one page of an account's events.
 */
const MUTABLE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * How far back the first poll after a launch reads for conversations already
 * priced. This process kept no "last poll" across the restart, and a charge
 * still growing when the last daemon stopped must be re-read; a week also
 * covers a machine left off over a weekend. A conversation's settled half is
 * never read back in (`ConversationSpend.settledBeforeMs`), so a wider window
 * costs pages and never double counts.
 */
const FIRST_POLL_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/**
 * The furthest back any poll reads. A conversation never priced is priced
 * from its run's start — every charge it ever made — and this bounds that for
 * a run older than the account's history is worth paging through.
 */
const MAX_BACKFILL_MS = 90 * 24 * 60 * 60_000;

/**
 * Slack before a run's start when pricing its conversations for the first
 * time: the account stamps an event with ITS clock, not this machine's.
 */
const RUN_START_MARGIN_MS = 10 * 60_000;

/**
 * The columns a poll reads of a run. It writes runs only through
 * `nativeUpdate`, so the rows are read-only projections and stay out of the
 * identity map.
 */
const RUN_READ = {
  fields: [
    'id',
    'agentKind',
    'createdAt',
    'polledCostCents',
    'polledCostEvents',
  ],
  disableIdentityMap: true,
} as const;

/**
 * A run as a poll holds it. Typed to the projection, so reading a column
 * {@link RUN_READ} leaves out is a compile error rather than an `undefined`.
 */
type PolledRun = Pick<Run, (typeof RUN_READ)['fields'][number]>;

/** One node holding conversations of the polled CLI, as a poll restates it. */
interface PolledNode {
  run: PolledRun;
  nodeId: string;
  /** Every conversation the node has held. */
  conversations: string[];
  /** What the ledger held before this poll, by conversation id. */
  ledger: Map<string, ConversationSpend>;
  /** The stored text, so an unchanged ledger is not written again. */
  ledgerText: string | null;
  cents: number | null;
  events: number | null;
}

/**
 * Every node of the runs a poll covers that holds NO conversation of the
 * polled CLI — kept only for its share of the run's total, which a workflow
 * run sums across nodes.
 */
interface OtherNodeShare {
  runId: string;
  cents: number;
  events: number;
}

/**
 * What each conversation of a POLLED-spend CLI has cost — a CLI whose turns
 * carry no price (`AdapterConfig.usage.polledSpend`) — fetched in one batched
 * poll per CLI through that adapter's own `fetchAccountSpend`, and restated onto
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
 * - It **restates**: each conversation's ledger on `node_state` holds its settled
 *   charges plus every charge still inside the window at the account's latest
 *   amount, and every total is SET from those ledgers. It used to ACCUMULATE —
 *   count each event once, at its first sight — and an account raises an
 *   event's charge while its request runs, so that undercounted by up to ten
 *   times (see `AccountSpendEvent`).
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
      const { nodes, others } = await this.nodesFor(kind, em);
      if (nodes.length === 0) {
        return;
      }
      const lastSuccess = this.lastSuccessMs.get(kind);
      let startMs =
        lastSuccess === undefined
          ? now - FIRST_POLL_LOOKBACK_MS
          : lastSuccess - MUTABLE_WINDOW_MS;
      // A conversation never priced is priced from its run's start, so every
      // charge it ever made is read once.
      for (const node of nodes) {
        if (node.conversations.some((id) => !node.ledger.has(id))) {
          startMs = Math.min(
            startMs,
            node.run.createdAt.getTime() - RUN_START_MARGIN_MS,
          );
        }
      }
      startMs = Math.max(startMs, now - MAX_BACKFILL_MS);
      const spend = await adapter.fetchAccountSpend({ startMs, endMs: now });
      if (spend === null) {
        return;
      }
      await this.writeSpend(nodes, others, spend, startMs, em, now);
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
   * Every node holding a conversation of this CLI, with what its ledger
   * already says. The join is the session id `node_state` already records,
   * which is what the account calls the conversation — so nothing new is
   * stored to make the attribution exact.
   *
   * Runs whose OWN agent is this CLI (a 1:1 chat) PLUS runs merely holding a
   * node that ran on it — every workflow routing work to it, whose run row
   * names no agent at all. The run's OTHER nodes come back as shares only, so
   * the run's total can be summed across all of them.
   */
  private async nodesFor(
    kind: AgentKind,
    em: EntityManager,
  ): Promise<{ nodes: PolledNode[]; others: OtherNodeShare[] }> {
    const nodes: PolledNode[] = [];
    const others: OtherNodeShare[] = [];
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
          others.push({
            runId: row.id,
            cents: state.polledCostCents ?? 0,
            events: state.polledCostEvents ?? 0,
          });
          continue;
        }
        // EVERY conversation the node held, not only the one it would resume:
        // each call to a node is a conversation of its own and a compaction
        // replaces one, and `agentSessionId` is overwritten by every turn.
        const conversations = new Set(readNodeSessions(state.sessionIds));
        if (state.agentSessionId !== null && state.agentSessionId !== '') {
          conversations.add(state.agentSessionId);
        }
        if (conversations.size === 0) {
          continue;
        }
        nodes.push({
          run: row,
          nodeId: state.nodeId,
          conversations: [...conversations],
          ledger: readSpendLedger(state.polledSpendLedger),
          ledgerText: state.polledSpendLedger,
          cents: state.polledCostCents,
          events: state.polledCostEvents,
        });
      }
    }
    return { nodes, others };
  }

  /**
   * Restate every node's ledger and totals from one window the account
   * answered WHOLE, then each run's total from its nodes, and TELL every
   * window whose run's figure moved.
   *
   * Every figure is SET from the ledgers rather than added to, so a write that
   * failed half way is simply restated by the next poll — nothing here can
   * count a charge twice or lose one for good.
   *
   * The announce is what makes a new price visible in a thread that is already
   * open — a `run_status` with `status: null`, since this says what the run has
   * SPENT and nothing about whether it is still going, and only for a run whose
   * figure actually moved.
   */
  private async writeSpend(
    nodes: readonly PolledNode[],
    others: readonly OtherNodeShare[],
    spend: ReadonlyMap<string, readonly AccountSpendEvent[]>,
    windowStartMs: number,
    em: EntityManager,
    at: number,
  ): Promise<void> {
    const byRun = new Map<
      string,
      { run: PolledRun; cents: number; events: number }
    >();
    for (const node of nodes) {
      const ledger = new Map<string, ConversationSpend>();
      let cents = 0;
      let events = 0;
      for (const conversationId of node.conversations) {
        const restated = restateConversation(
          node.ledger.get(conversationId),
          spend.get(conversationId) ?? [],
          windowStartMs,
        );
        ledger.set(conversationId, restated);
        const figures = conversationSpend(restated);
        cents += figures.cents;
        events += figures.events;
      }
      const ledgerText = writeSpendLedger(ledger);
      if (
        ledgerText !== node.ledgerText ||
        cents !== (node.cents ?? 0) ||
        events !== (node.events ?? 0)
      ) {
        await this.nodeStates.writePolledSpend(
          node.run.id,
          node.nodeId,
          { ledger: ledgerText, cents, events },
          em,
        );
      }
      const total = byRun.get(node.run.id) ?? {
        run: node.run,
        cents: 0,
        events: 0,
      };
      total.cents += cents;
      total.events += events;
      byRun.set(node.run.id, total);
    }
    // A workflow mixing CLIs: its other nodes' polled shares, if any, are
    // part of the run's total too.
    for (const share of others) {
      const total = byRun.get(share.runId);
      if (total !== undefined) {
        total.cents += share.cents;
        total.events += share.events;
      }
    }
    for (const { run, cents, events } of byRun.values()) {
      if (
        cents === (run.polledCostCents ?? 0) &&
        events === (run.polledCostEvents ?? 0)
      ) {
        continue;
      }
      await this.runDao.updateWithoutActivity(
        run.id,
        { polledCostCents: cents, polledCostEvents: events },
        em,
      );
      run.polledCostCents = cents;
      run.polledCostEvents = events;
      this.bus.publishRunStatus({
        runId: run.id,
        status: null,
        spendUpdatedAt: at,
      });
    }
  }
}
