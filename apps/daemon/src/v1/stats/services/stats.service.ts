import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import type { ChatTotalsWire } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import {
  addPolledSpend,
  addUsage,
  emptyTotals,
} from '../../agents/utils/usage-figures';
import { UsageEventDao } from '../dao/usage-event.dao';
import type { UsageEvent } from '../entity/usage-event.entity';
import type { UsageGroupWire, UsageStatsWire } from '../stats.types';
import { isPolledSpend } from '../utils/polled-spend';
import { eachLocalDay, localDateKey } from '../utils/usage-fold';
import { ProjectRootsService } from './project-roots.service';

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
    /** Read for which CLIs' money is polled — each one's own `usage.polledSpend`. */
    private readonly adapters: AgentAdapterRegistry,
    /** Which project a folder's spend is filed under — a worktree's repository. */
    private readonly projectRoots: ProjectRootsService,
    /** The thread titles the per-thread breakdown is labelled with. */
    private readonly runDao: RunDao,
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
    // A worktree is not a project: each folder is filed under the project it
    // belongs to before anything is summed — see `ProjectRootsService`.
    const roots = await this.projectRoots.rootsOf(
      events.map((event) => event.cwd),
    );
    const projectOf = (cwd: string | null): string | null =>
      cwd === null ? null : (roots.get(cwd) ?? cwd);

    const totals = emptyTotals();
    const byDay = new Map<string, ChatTotalsWire>();
    const byAgent = new Map<string | null, ChatTotalsWire>();
    const byModel = new Map<string | null, ChatTotalsWire>();
    const byProject = new Map<string | null, ChatTotalsWire>();
    const byThread = new Map<string | null, ChatTotalsWire>();

    /**
     * Turns the ledger holds no price for, per run and per agent.
     *
     * They are the turns a POLLED price belongs to — see `addPolledSpend`. The
     * tally is built here rather than re-queried because this loop is already
     * reading every event in the period, and the predicate is the CLI-agnostic
     * one (`costUsd === null` means nobody priced this turn) rather than a test
     * on which agent ran it. Keyed by agent so a workflow's polled money is
     * credited to each CLI with that CLI's own turns, and so the fold below can
     * leave out the turns of a CLI nobody polls.
     */
    const unpricedTurns = new Map<string, number>();
    /** Each run's polled-spend row in the period — folded once the turns are. */
    const polled: UsageEvent[] = [];

    for (const event of events) {
      if (isPolledSpend(event)) {
        polled.push(event);
        continue;
      }
      addUsage(totals, event);
      addUsage(bucket(byDay, localDateKey(event.occurredAt)), event);
      addUsage(bucket(byAgent, event.agentKind), event);
      addUsage(bucket(byModel, event.model), event);
      addUsage(bucket(byProject, projectOf(event.cwd)), event);
      // Per THREAD, chats and workflow runs alike. It replaced a per-workflow
      // breakdown whose null key pooled every chat into one "Chats" row —
      // REPORTED as combining everything into one bucket — when the question a
      // reader brings here is which conversations cost the most.
      addUsage(bucket(byThread, event.runId), event);
      if (event.costUsd === null) {
        const key = turnKey(event.runId, event.agentKind);
        unpricedTurns.set(key, (unpricedTurns.get(key) ?? 0) + 1);
      }
    }

    // Then the spend nobody's TURN reported.
    //
    // A polled-spend CLI prices nothing on its own wire, so its money reaches
    // this app through an account poll alone — a page summing turns would show
    // every one of its runs as costing nothing.
    //
    // Read from the LEDGER's own polled row per run, never off the run: that
    // row outlives the run, so deleting a chat no longer takes its bill out of
    // every lifetime figure — and reading one source rather than two is what
    // keeps a live run's bill from being counted twice. Every dimension is
    // credited from that same row, so the page stays internally consistent:
    // the headline, the day, the agent, the model, the folder and the thread
    // all move together and each column still sums to the total.
    const adapters = this.adapters.all();
    const polledKinds = [...adapters.keys()].filter((kind) =>
      pollsSpendFor(adapters, kind),
    );
    for (const event of polled) {
      const costUsd = event.costUsd ?? 0;
      if (costUsd <= 0) {
        continue;
      }
      // Only turns of a CLI whose money is polled. An unpriced turn of one that
      // is not (no cost on its wire, no account to ask) stays unmeasured;
      // counting it would spread this bill over a turn it never paid for.
      const turns = polledTurns(unpricedTurns, polledKinds, event.runId);
      addPolledSpend(totals, costUsd, turns);
      addPolledSpend(
        bucket(byDay, localDateKey(event.occurredAt)),
        costUsd,
        turns,
      );
      // The agent's own divisor is that agent's unpriced turns alone: the row
      // names the one CLI whose money this is, so a workflow's other agents'
      // turns are not part of what it is spread over.
      addPolledSpend(
        bucket(byAgent, event.agentKind),
        costUsd,
        unpricedTurns.get(turnKey(event.runId, event.agentKind)) ?? 0,
      );
      addPolledSpend(bucket(byModel, event.model), costUsd, turns);
      addPolledSpend(bucket(byProject, projectOf(event.cwd)), costUsd, turns);
      // The polled row is keyed by its own run, so a run's bill lands on that
      // thread's row with the turns it was spread over.
      addPolledSpend(bucket(byThread, event.runId), costUsd, turns);
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
      byThread: await this.titled(rank(byThread), em),
    };
  }

  /**
   * The per-thread rows with each thread's title, read off the runs in ONE
   * query. A run deleted since keeps its spend here — the ledger outlives it —
   * and says so rather than passing for an untitled thread.
   */
  private async titled(
    groups: UsageGroupWire[],
    em: EntityManager,
  ): Promise<UsageGroupWire[]> {
    const ids = groups
      .map((group) => group.key)
      .filter((key): key is string => key !== null);
    if (ids.length === 0) {
      return groups;
    }
    const titles = new Map(
      (
        await this.runDao.getAll(
          { id: { $in: ids } },
          { fields: ['id', 'title'], disableIdentityMap: true },
          em,
        )
      ).map((run) => [run.id, run.title]),
    );
    return groups.map((group) =>
      group.key === null
        ? group
        : {
            ...group,
            title: titles.get(group.key) ?? null,
            deleted: !titles.has(group.key),
          },
    );
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

/** The unpriced-turn tally key for one run and one agent. */
function turnKey(runId: string, agentKind: string | null): string {
  return `${runId}\u0000${agentKind ?? ''}`;
}

/** One run's unpriced turns that belong to a CLI whose money is polled. */
function polledTurns(
  unpricedTurns: ReadonlyMap<string, number>,
  polledKinds: readonly string[],
  runId: string,
): number {
  let turns = 0;
  for (const kind of polledKinds) {
    turns += unpricedTurns.get(turnKey(runId, kind)) ?? 0;
  }
  return turns;
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
