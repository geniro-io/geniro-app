import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import type { ChatTotalsWire } from '../../agents/chat.types';
import { addUsage, emptyTotals } from '../../agents/utils/usage-figures';
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
