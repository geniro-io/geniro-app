import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import type { AccountSpendEvent } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { asRecord, asString, parseJsonColumn } from '../utils/json-util';
import { readNodeSessions } from '../utils/node-sessions';
import { pollsSpendFor } from '../utils/polled-spend';
import {
  type ConversationSpend,
  ledgerTotals,
  type PolledSpendLedger,
  readPolledSpendLedger,
  spendBucket,
  unpricedConversation,
  withAccountEvents,
  writePolledSpendLedger,
} from '../utils/polled-spend-ledger';
import {
  snapshotNodePoolProfiles,
  snapshotPoolKinds,
} from '../utils/snapshot-config-dirs';
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
 * How long an event stays open to revision before its charge is taken as final.
 *
 * A vendor lists a long request early and raises its charge as it runs, so an
 * event is re-read by every poll for this long after its date. A day is far
 * past any single request, and it is also what a steady-state poll reads: the
 * window starts at the oldest open event, which is never older than this.
 */
const SETTLE_AFTER_MS = 24 * 60 * 60_000;

/**
 * How far back the account can be asked at all. Cursor's own dashboard offers
 * thirty days, and a first pricing of a conversation older than that has
 * nothing more to find.
 */
const ACCOUNT_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

/**
 * How far before its node was created a never-priced conversation's events
 * may begin. A conversation geniro holds starts with a node of geniro's, so
 * pricing it from there — not from the account's thirty days — keeps a new
 * conversation from turning the next poll into a month-long walk; the slack
 * covers a clock or a write that lagged the request.
 */
const NODE_START_SLACK_MS = 60 * 60_000;

/**
 * The four columns a poll reads of a run. It writes runs only through
 * `nativeUpdate`, so the rows are read-only projections and stay out of the
 * identity map.
 */
const RUN_READ = {
  fields: [
    'id',
    'agentKind',
    'polledCostCents',
    'polledCostEvents',
    'polledSpendBuckets',
    'workflowSnapshot',
  ],
  disableIdentityMap: true,
} as const;

/**
 * A run as a poll holds it. Typed to the projection, so reading a column
 * {@link RUN_READ} leaves out is a compile error rather than an `undefined`.
 */
type PolledRun = Pick<Run, (typeof RUN_READ)['fields'][number]>;

/** One node whose conversations a poll prices, and everything they are. */
interface NodeTarget {
  run: PolledRun;
  state: NodeState;
  /** Its ledger as stored, before this poll. */
  stored: PolledSpendLedger;
  /** Each conversation it is answerable for, with its ledger entry so far. */
  conversations: Map<string, ConversationSpend>;
}

/**
 * What each conversation of a POLLED-spend CLI has cost — a CLI whose turns
 * carry no price (`AdapterConfig.usage.polledSpend`) — fetched in one batched
 * poll per CLI through that adapter's own `fetchAccountSpend`, and written onto
 * the nodes and runs holding those conversations.
 *
 * Every fact about HOW an account is asked lives in the adapter; this service
 * owns only the cadence, the ledgers and the writes. Four properties shape it:
 *
 * - It is **batched and floored**, on TWO floors — {@link MIN_POLL_INTERVAL_MS}
 *   for an ambient caller and {@link LIVE_POLL_INTERVAL_MS} while a polled
 *   conversation is producing items — and never runs two polls at once, so
 *   there is no per-thread or per-message request anywhere.
 * - It **fails closed and silent**: an adapter that cannot read its account
 *   answers null, which ends as "no cost reported". A missing price is never an
 *   error strip.
 * - It **re-reads rather than accumulates**: each node keeps a per-event ledger
 *   (`NodeState.polledSpend`) and every poll REPLACES the events it reads, so a
 *   charge the vendor raised after first listing it is followed rather than
 *   frozen; only events older than {@link SETTLE_AFTER_MS} are folded into a
 *   settled sum.
 * - It prices **every conversation a node is answerable for**: the sessions it
 *   ran in, the conversations callers held with it (from its `call_result`
 *   rows, which outlive the session history on runs older than that column),
 *   and every delegate those spawned (`AgentAdapter.spawnedConversations`) —
 *   the account bills each of them separately, and a delegate's charges were
 *   most of what a real account spent.
 */
@Injectable()
export class PolledSpendService implements OnModuleInit {
  private readonly logger = new Logger(PolledSpendService.name);

  /** When the last poll ATTEMPT started — the floor is on attempts, not wins. */
  private lastAttemptAtMs = 0;
  /** The poll in flight, so concurrent callers join it rather than duplicate it. */
  private inFlight: Promise<void> | null = null;
  /**
   * Which rows belong to a polled CLI, keyed `<runId>\0<nodeId>`, so the live
   * tick costs one indexed read per row and not one per item. A run's (and a
   * node's) agent never changes once known, so an entry never goes stale; it
   * is dropped with its run.
   */
  private readonly polledRows = new Map<string, boolean>();

  constructor(
    private readonly runDao: RunDao,
    private readonly nodeStates: NodeStateDao,
    private readonly itemDao: ItemDao,
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
      if (states.some((state) => this.pollsSpend(state.agentKind))) {
        return true;
      }
      // A pooled node is stamped with member 1 while one of its other members
      // may be the polled one.
      const run = await this.runDao.getById(runId, this.em.fork());
      return [
        ...snapshotPoolKinds(run?.workflowSnapshot ?? null).values(),
      ].some((kinds) => kinds.some((kind) => this.pollsSpend(kind)));
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
      // A pooled node's row is stamped with member 1, while its calls may
      // run on a polled member — the pool, fixed for the run, says so.
      if (
        (snapshotPoolKinds(run.workflowSnapshot).get(nodeId) ?? []).some(
          (kind) => this.pollsSpend(kind),
        )
      ) {
        this.polledRows.set(key, true);
        return true;
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
      const targets = await this.targetsFor(kind, adapter, em, now);
      const owners = new Map<string, NodeTarget>();
      let startMs = now;
      for (const target of targets.values()) {
        for (const [conversationId, spend] of target.conversations) {
          owners.set(conversationId, target);
          startMs = Math.min(startMs, spend.settledThroughMs);
        }
      }
      if (owners.size === 0) {
        return;
      }
      const reply = await adapter.fetchAccountSpend({
        startMs: Math.max(startMs, now - ACCOUNT_LOOKBACK_MS),
        endMs: now,
        conversations: new Set(owners.keys()),
      });
      if (reply === null) {
        return;
      }
      const byConversation = new Map<string, AccountSpendEvent[]>();
      for (const event of reply.events) {
        const list = byConversation.get(event.conversationId) ?? [];
        list.push(event);
        byConversation.set(event.conversationId, list);
      }
      await this.writeSpend(
        targets,
        byConversation,
        reply.complete ? now - SETTLE_AFTER_MS : null,
        em,
        now,
      );
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
   * Every node holding a conversation of this CLI, keyed `<runId>\0<nodeId>`,
   * with each conversation it is answerable for.
   *
   * Runs whose OWN agent is this CLI (a 1:1 chat) PLUS runs merely holding a
   * node that ran on it — every workflow routing work to it, whose run row
   * names no agent at all. A conversation is claimed by ONE node, first come:
   * the sessions nodes ran in, then the conversations callers held with them,
   * then the delegates any of those spawned — so no charge is counted twice.
   */
  private async targetsFor(
    kind: AgentKind,
    adapter: AgentAdapter,
    em: EntityManager,
    now: number,
  ): Promise<Map<string, NodeTarget>> {
    const targets = new Map<string, NodeTarget>();
    const claimed = new Set<string>();
    const runIds = new Set(await this.nodeStates.runIdsForAgent(kind, em));
    // A pooled node's stamp is member 1's, so a run whose pool holds this CLI
    // is a candidate whatever it is stamped.
    for (const pooled of await this.runDao.getAll(
      { workflowSnapshot: { $like: `%"agent":"${kind}"%` } },
      { fields: ['id'], disableIdentityMap: true },
      em,
    )) {
      runIds.add(pooled.id);
    }
    const runs = await this.runDao.getAll({ agentKind: kind }, RUN_READ, em);
    for (const row of runs) {
      runIds.delete(row.id);
    }
    const withNodes =
      runIds.size === 0
        ? []
        : await this.runDao.getAll({ id: { $in: [...runIds] } }, RUN_READ, em);
    const calls: { target: NodeTarget; sessionId: string }[] = [];
    for (const row of [...runs, ...withNodes]) {
      const byNode = new Map<string, NodeTarget>();
      const pools = snapshotNodePoolProfiles(row.workflowSnapshot);
      for (const state of await this.nodeStates.listByRun(row.id, em)) {
        // A workflow's node on another CLI holds a session id from THAT CLI's
        // store, which this account has never heard of — never offer it. A
        // pooled node is this CLI's when any of its members is.
        if (
          row.agentKind !== kind &&
          state.agentKind !== kind &&
          !(pools.get(state.nodeId) ?? []).some(
            (profile) => profile?.agentKind === kind,
          )
        ) {
          continue;
        }
        const target: NodeTarget = {
          run: row,
          state,
          stored: readPolledSpendLedger(state.polledSpend),
          conversations: new Map(),
        };
        targets.set(`${row.id}\u0000${state.nodeId}`, target);
        byNode.set(state.nodeId, target);
        // EVERY conversation the node held, not only the one it would resume:
        // each call to a node is a conversation of its own and a compaction
        // replaces one, while `agentSessionId` is overwritten by every turn.
        const sessions = readNodeSessions(state.sessionIds);
        if (state.agentSessionId !== null && state.agentSessionId !== '') {
          sessions.push(state.agentSessionId);
        }
        for (const sessionId of sessions) {
          this.claim(target, sessionId, claimed, now);
        }
      }
      if (byNode.size === 0) {
        continue;
      }
      // The conversations callers held with a node, as its `call_result` rows
      // record them — the only record on a run older than the session history.
      for (const record of await this.itemDao.callRecordRows(row.id, em)) {
        if (record.kind !== 'call_result') {
          continue;
        }
        const payload = asRecord(parseJsonColumn(record.payload));
        const callee = asString(payload?.calleeNodeId);
        const sessionId = asString(payload?.sessionId);
        const target = callee === null ? undefined : byNode.get(callee);
        if (target !== undefined && sessionId !== null && sessionId !== '') {
          calls.push({ target, sessionId });
        }
      }
    }
    for (const { target, sessionId } of calls) {
      this.claim(target, sessionId, claimed, now);
    }
    // The delegates every claimed conversation launched, billed under their
    // own ids — attributed to the node whose conversation launched them.
    const parents = new Map<string, NodeTarget>();
    for (const target of targets.values()) {
      for (const conversationId of target.conversations.keys()) {
        parents.set(conversationId, target);
      }
    }
    const spawned = await adapter.spawnedConversations([...parents.keys()]);
    for (const [parent, children] of spawned) {
      const target = parents.get(parent);
      if (target === undefined) {
        continue;
      }
      // A delegate cannot be billed before the conversation that launched it
      // was last open, so it starts there rather than at the node's birth —
      // which, on a chat weeks old, would make every new delegate a walk
      // through weeks of the account.
      const from = target.conversations.get(parent)?.settledThroughMs;
      for (const child of children) {
        this.claim(target, child, claimed, now, from);
      }
    }
    return targets;
  }

  /**
   * File one conversation under a node, unless another node already has it,
   * with its ledger entry so far — or, for one never priced, an empty entry
   * starting at `fromMs`, else where the node did.
   *
   * A node priced before the per-event ledger existed holds a total and no
   * ledger. If it began inside the account's window, that total is re-derived
   * from scratch, which is the point. If it began BEFORE, the account can no
   * longer answer for its start, so its old total is kept as settled and only
   * what is billed from now on is added to it.
   */
  private claim(
    target: NodeTarget,
    conversationId: string,
    claimed: Set<string>,
    now: number,
    fromMs?: number,
  ): void {
    if (claimed.has(conversationId)) {
      return;
    }
    claimed.add(conversationId);
    const stored = target.stored.get(conversationId);
    if (stored !== undefined) {
      target.conversations.set(conversationId, stored);
      return;
    }
    const createdAtMs = target.state.createdAt.getTime();
    const legacyCents = target.state.polledCostCents ?? 0;
    const predatesWindow = createdAtMs < now - ACCOUNT_LOOKBACK_MS;
    if (target.stored.size === 0 && legacyCents > 0 && predatesWindow) {
      const carried = [...target.conversations.values()].some(
        (spend) => Object.keys(spend.settled).length > 0,
      );
      target.conversations.set(conversationId, {
        ...unpricedConversation(now),
        ...(carried
          ? {}
          : {
              // The account no longer lists these charges, so neither their
              // days nor their models are known: dated at the node's start,
              // under no model.
              settled: {
                [spendBucket(createdAtMs, '')]: [
                  legacyCents,
                  target.state.polledCostEvents ?? 0,
                ] as [number, number],
              },
            }),
      });
      return;
    }
    target.conversations.set(
      conversationId,
      unpricedConversation(fromMs ?? createdAtMs - NODE_START_SLACK_MS),
    );
  }

  /**
   * Rewrite each node's ledger and total, then each run's total as the sum of
   * its nodes', and TELL every window what changed.
   *
   * Only a figure that MOVED is written or announced: a poll covers every
   * polled conversation on the machine, and an event per thread every minute
   * saying nothing changed would be noise on the wire. The announce is a
   * `run_status` with `status: null`, since this says what the run has SPENT
   * and nothing about whether it is still going.
   */
  private async writeSpend(
    targets: ReadonlyMap<string, NodeTarget>,
    byConversation: ReadonlyMap<string, readonly AccountSpendEvent[]>,
    settleBeforeMs: number | null,
    em: EntityManager,
    at: number,
  ): Promise<void> {
    const runs = new Map<string, PolledRun>();
    const nodeTotals = new Map<
      string,
      Map<string, { cents: number; events: number }>
    >();
    const runBuckets = new Map<string, Map<string, number>>();
    for (const target of targets.values()) {
      const ledger: PolledSpendLedger = new Map();
      for (const [conversationId, spend] of target.conversations) {
        ledger.set(
          conversationId,
          withAccountEvents(
            spend,
            byConversation.get(conversationId) ?? [],
            settleBeforeMs,
          ),
        );
      }
      const totals = ledgerTotals(ledger);
      const serialized = writePolledSpendLedger(ledger);
      const { state, run } = target;
      runs.set(run.id, run);
      const perRun = nodeTotals.get(run.id) ?? new Map();
      perRun.set(state.nodeId, { cents: totals.cents, events: totals.events });
      nodeTotals.set(run.id, perRun);
      const buckets = runBuckets.get(run.id) ?? new Map<string, number>();
      for (const [bucket, { cents }] of totals.buckets) {
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + cents);
      }
      runBuckets.set(run.id, buckets);
      if (
        serialized !== state.polledSpend ||
        totals.cents !== (state.polledCostCents ?? 0) ||
        totals.events !== (state.polledCostEvents ?? 0)
      ) {
        await this.nodeStates.writePolledSpend(
          run.id,
          state.nodeId,
          { ledger: serialized, cents: totals.cents, events: totals.events },
          em,
        );
      }
    }
    for (const [runId, perNode] of nodeTotals) {
      const run = runs.get(runId);
      if (run === undefined) {
        continue;
      }
      let cents = 0;
      let events = 0;
      for (const totals of perNode.values()) {
        cents += totals.cents;
        events += totals.events;
      }
      const sorted = [...(runBuckets.get(runId) ?? new Map<string, number>())]
        .filter(([, amount]) => amount !== 0)
        .sort(([a], [b]) => a.localeCompare(b));
      const buckets =
        sorted.length === 0 ? null : JSON.stringify(Object.fromEntries(sorted));
      if (
        cents === (run.polledCostCents ?? 0) &&
        events === (run.polledCostEvents ?? 0) &&
        buckets === run.polledSpendBuckets
      ) {
        continue;
      }
      await this.runDao.updateWithoutActivity(
        runId,
        {
          polledCostCents: cents,
          polledCostEvents: events,
          polledSpendBuckets: buckets,
        },
        em,
      );
      run.polledCostCents = cents;
      run.polledCostEvents = events;
      run.polledSpendBuckets = buckets;
      this.bus.publishRunStatus({
        runId,
        status: null,
        spendUpdatedAt: at,
      });
    }
  }
}
