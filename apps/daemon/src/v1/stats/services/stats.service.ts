import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import type { ChatTotalsWire } from '../../agents/chat.types';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import {
  addPolledSpend,
  addUsage,
  emptyTotals,
} from '../../agents/utils/usage-figures';
import { UsageEventDao } from '../dao/usage-event.dao';
import type { UsageGroupWire, UsageStatsWire } from '../stats.types';
import { eachLocalDay, localDateKey } from '../utils/usage-fold';

/** What a range resolves to when the caller names neither end and the ledger is empty. */
const EMPTY_RANGE_DAYS = 30;

/**
 * What the app has spent, over a period.
 *
 * The summing happens HERE rather than in the renderer for the same reason the
 * per-chat totals do: the client holds no ledger, and one that fetched raw
 * events would total whatever page of them it happened to have — silently,
 * since a smaller number looks exactly like a cheaper month.
 *
 * Read-only, on a forked EntityManager. Nothing in this module writes as a
 * consequence of someone opening the page.
 */
@Injectable()
export class StatsService {
  constructor(
    private readonly em: EntityManager,
    private readonly usageDao: UsageEventDao,
    /**
     * Read for the spend no turn reported — see the polled-spend fold in
     * {@link usage}. `StatsModule` already imports `AgentsModule` for exactly
     * this kind of read, and the direction is unchanged: this module observes
     * the agent plane and nothing there depends on it.
     */
    private readonly runDao: RunDao,
    /** Read for which CLI each workflow node's polled money belongs to. */
    private readonly nodeStateDao: NodeStateDao,
  ) {}

  /**
   * Both bounds arrive as ISO-8601 strings and are turned into instants here.
   *
   * The parsing lives with the range resolution rather than at the route,
   * because this service already owns what a range MEANS — what an omitted
   * bound falls back to, and which direction is refused. Splitting the two
   * would put half of that decision in a controller.
   */
  async usage(fromIso?: string, toIso?: string): Promise<UsageStatsWire> {
    const em = this.em.fork();
    const range = await this.resolveRange(
      fromIso === undefined ? undefined : new Date(fromIso),
      toIso === undefined ? undefined : new Date(toIso),
      em,
    );
    const events = await this.usageDao.inRange(range.from, range.to, em);

    const totals = emptyTotals();
    const byDay = new Map<string, ChatTotalsWire>();
    const byAgent = new Map<string | null, ChatTotalsWire>();
    const byModel = new Map<string | null, ChatTotalsWire>();
    const byProject = new Map<string | null, ChatTotalsWire>();
    const byWorkflow = new Map<string | null, ChatTotalsWire>();

    /**
     * Turns the ledger holds no price for, per run and per agent.
     *
     * They are the turns a POLLED price belongs to — see `addPolledSpend`. The
     * tally is built here rather than re-queried because this loop is already
     * reading every event in the period, and the predicate is the CLI-agnostic
     * one (`costUsd === null` means nobody priced this turn) rather than a test
     * on which agent ran it. Keyed by agent too, so a workflow's polled money
     * is credited to each CLI with that CLI's own turns.
     */
    const unpricedTurns = new Map<string, number>();

    for (const event of events) {
      addUsage(totals, event);
      addUsage(bucket(byDay, localDateKey(event.occurredAt)), event);
      addUsage(bucket(byAgent, event.agentKind), event);
      addUsage(bucket(byModel, event.model), event);
      addUsage(bucket(byProject, event.cwd), event);
      // The null key is every single-agent chat, which is a real and useful
      // row here rather than an absence: it is what the workflows are being
      // compared against.
      addUsage(bucket(byWorkflow, event.workflowName), event);
      if (event.costUsd === null) {
        for (const key of [
          event.runId,
          turnKey(event.runId, event.agentKind),
        ]) {
          unpricedTurns.set(key, (unpricedTurns.get(key) ?? 0) + 1);
        }
      }
    }

    // Then the spend nobody's TURN reported.
    //
    // A polled-spend CLI prices nothing on its own wire, so its money reaches
    // this app through an account poll that lands on the run row. Measured on
    // a real ledger before this was read: `byAgent` answered claude $32,581.96
    // and cursor-agent `costUsd: null` over 82 turns, while the runs themselves
    // carried $215.01 the page never read.
    //
    // Every dimension is credited from the SAME run row, so the page stays
    // internally consistent: the headline, the day, the agent, the model and
    // the folder all move together and each column still sums to the total. The
    // day is the run's last activity, which is an approximation the DAO's own
    // doc block states in full.
    const polledRuns = await this.runDao.withPolledSpendInRange(
      range.from,
      range.to,
      em,
    );
    const sharesByRun = await this.nodeShares(polledRuns, em);
    for (const run of polledRuns) {
      const costUsd = (run.polledCostCents ?? 0) / 100;
      if (costUsd <= 0) {
        continue;
      }
      const turns = unpricedTurns.get(run.id) ?? 0;
      addPolledSpend(totals, costUsd, turns);
      addPolledSpend(
        bucket(byDay, localDateKey(run.updatedAt)),
        costUsd,
        turns,
      );
      for (const [agent, share] of agentShares(
        run,
        costUsd,
        sharesByRun.get(run.id),
      )) {
        addPolledSpend(
          bucket(byAgent, agent),
          share,
          unpricedTurns.get(turnKey(run.id, agent)) ?? 0,
        );
      }
      addPolledSpend(bucket(byModel, run.model), costUsd, turns);
      addPolledSpend(bucket(byProject, run.cwd), costUsd, turns);
      // The one dimension a run row cannot answer: `byWorkflow` keys on the
      // workflow's NAME, which lives in the YAML library, while the run carries
      // only its slug. A 1:1 chat is the null key — the real row this breakdown
      // compares workflows against — and a workflow run's polled spend is left
      // out rather than filed under a key that would not match the ledger's own.
      if (run.workflowId === null) {
        addPolledSpend(bucket(byWorkflow, null), costUsd, turns);
      }
    }

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      totals,
      // Every day in the range, not only the ones with turns — see
      // `eachLocalDay`: a chart that omitted the quiet days would draw the busy
      // ones as adjacent.
      days: eachLocalDay(range.from, range.to).map((date) => ({
        date,
        totals: byDay.get(date) ?? emptyTotals(),
      })),
      byAgent: rank(byAgent),
      byModel: rank(byModel),
      byProject: rank(byProject),
      byWorkflow: rank(byWorkflow),
    };
  }

  /**
   * Fill in whichever end the caller left out.
   *
   * An absent `to` is now, and an absent `from` is the ledger's own first
   * recorded turn — "all time" is the only honest reading of a lower bound
   * nobody named, and on an empty ledger it falls back to a recent window so
   * the page opens on a sensible axis rather than on the epoch.
   */
  private async resolveRange(
    from: Date | undefined,
    to: Date | undefined,
    em: EntityManager,
  ): Promise<{ from: Date; to: Date }> {
    // An unparseable bound is refused rather than allowed through as an
    // `Invalid Date`: every comparison against one is false, so the range would
    // silently match no rows and the page would report a period in which
    // nothing was spent. The route's schema already rejects the shape; this
    // covers a caller that reached the service directly.
    for (const bound of [from, to]) {
      if (bound !== undefined && Number.isNaN(bound.getTime())) {
        throw new BadRequestException(
          'STATS_RANGE_INVALID',
          'the range bounds must be ISO-8601 timestamps',
        );
      }
    }
    // Refused rather than silently swapped, and judged on the two bounds the
    // CALLER actually sent — never on one this method substituted or clamped.
    // Comparing against a substituted start made the same request 400 on a
    // populated ledger and succeed on an empty one; comparing against a clamped
    // end would answer a perfectly ordered future window with "the start is
    // after the end", which is not what the caller did wrong.
    if (
      from !== undefined &&
      to !== undefined &&
      from.getTime() > to.getTime()
    ) {
      throw new BadRequestException(
        'STATS_RANGE_INVALID',
        'the start of the range must not be after its end',
      );
    }

    // BOTH ends are then clamped to the span the ledger can actually answer
    // for. This is what BOUNDS the response: the reply carries one bucket per
    // calendar day in the RESOLVED range, so an unclamped bound expands the
    // body without limit — measured at ~375,000 buckets / ~69MB for
    // `from=1000-01-01`, and ~2.9 million / ~511MB for `to=9999-12-31`. Both
    // ends need it; clamping only the floor left the larger hole open. The
    // resolved range is echoed in the response, so a clamped request says so.
    //
    // The ceiling is NOW because a row's `occurredAt` is its source item's
    // `createdAt` — nothing is ever recorded in the future, so no range needs
    // to reach there. The floor is the ledger's own first recorded turn, for
    // the mirror-image reason.
    const now = new Date();
    const end = to === undefined || to.getTime() > now.getTime() ? now : to;
    const floor = await this.defaultStart(end, em);
    const requested = from ?? floor;
    const start = requested.getTime() < floor.getTime() ? floor : requested;
    // A start landing after `end` describes a period outside what the ledger
    // holds — entirely before its first turn, or entirely in the future. That
    // is an EMPTY range, which is the honest answer, rather than an error about
    // a bound the caller never sent.
    return { from: start.getTime() > end.getTime() ? end : start, to: end };
  }

  /**
   * How far back the ledger can answer for: its first recorded turn, or a
   * recent window when it holds nothing. Serves as both the default lower bound
   * and the floor every explicit one is clamped to.
   */
  /**
   * Each WORKFLOW run's polled money split by the CLI that spent it, off the
   * per-node shares the poll records beside the run's total — a workflow run
   * names no agent of its own, so its run row cannot say whose money it is.
   */
  private async nodeShares(
    runs: readonly { id: string; workflowId: string | null }[],
    em: EntityManager,
  ): Promise<Map<string, PolledShare[]>> {
    const ids = runs
      .filter((run) => run.workflowId !== null)
      .map((run) => run.id);
    const byRun = new Map<string, PolledShare[]>();
    if (ids.length === 0) {
      return byRun;
    }
    for (const row of await this.nodeStateDao.polledSharesForRuns(ids, em)) {
      const list = byRun.get(row.runId) ?? [];
      list.push({ agentKind: row.agentKind, cents: row.polledCostCents ?? 0 });
      byRun.set(row.runId, list);
    }
    return byRun;
  }

  private async defaultStart(end: Date, em: EntityManager): Promise<Date> {
    const earliest = await this.usageDao.earliestOccurredAt(em);
    if (earliest) {
      return earliest;
    }
    const fallback = new Date(end);
    fallback.setDate(fallback.getDate() - EMPTY_RANGE_DAYS);
    return fallback;
  }
}

/** One workflow node's recorded share of its run's polled money. */
interface PolledShare {
  agentKind: string | null;
  cents: number;
}

/** The unpriced-turn tally key for one run and one agent. */
function turnKey(runId: string, agentKind: string | null): string {
  return `${runId}\u0000${agentKind ?? ''}`;
}

/**
 * Which agent a run's polled dollars belong to. A chat's are its own agent's.
 * A workflow's are split by its nodes' shares, and whatever the shares do not
 * cover goes to the unknown-agent row rather than to a CLI that did not
 * necessarily spend it — so the column still sums to the total.
 */
function agentShares(
  run: { agentKind: string | null; workflowId: string | null },
  costUsd: number,
  shares: readonly PolledShare[] | undefined,
): [string | null, number][] {
  if (run.workflowId === null) {
    return [[run.agentKind, costUsd]];
  }
  const byAgent = new Map<string | null, number>();
  let covered = 0;
  for (const share of shares ?? []) {
    const dollars = share.cents / 100;
    byAgent.set(share.agentKind, (byAgent.get(share.agentKind) ?? 0) + dollars);
    covered += dollars;
  }
  const rest = costUsd - covered;
  if (rest > 0.005) {
    byAgent.set(null, (byAgent.get(null) ?? 0) + rest);
  }
  return [...byAgent];
}

function bucket<K>(buckets: Map<K, ChatTotalsWire>, key: K): ChatTotalsWire {
  const existing = buckets.get(key);
  if (existing) {
    return existing;
  }
  const fresh = emptyTotals();
  buckets.set(key, fresh);
  return fresh;
}

/**
 * Slices ordered by what they cost, dearest first — and by turn count where
 * nothing reported a cost, so a cursor-only breakdown still ranks by something
 * the user can act on instead of by map insertion order.
 */
function rank(buckets: Map<string | null, ChatTotalsWire>): UsageGroupWire[] {
  return [...buckets]
    .map(([key, totals]) => ({ key, totals }))
    .sort(
      (a, b) =>
        (b.totals.costUsd ?? 0) - (a.totals.costUsd ?? 0) ||
        b.totals.turns - a.totals.turns,
    );
}
