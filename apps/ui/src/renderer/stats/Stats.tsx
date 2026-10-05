import {
  Brain,
  Clock,
  DatabaseZap,
  Gauge,
  HardDriveDownload,
  MessagesSquare,
  PiggyBank,
  Repeat2,
  TrendingDown,
  Wallet,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { DaemonHandle } from '../../shared/contracts';
import { formatTokens, formatUsd } from '../chats/agent-activity';
import { shortenPath } from '../chats/directory-select';
import { EmptyState } from '../components/empty-state';
import { ErrorBanner } from '../components/error-banner';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { createDaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { BreakdownColumn } from './breakdown-card';
import { toDayPoints } from './chart-data';
import {
  CumulativeSpendChart,
  DailySeriesChart,
  TokenSplitChart,
} from './charts/time-charts';
import { StatCell, StatGrid } from './stat-card';
import {
  cacheHitRate,
  dayRangeTitle,
  formatCount,
  formatDuration,
  formatPercent,
  NOT_MEASURED,
} from './stats-format';
import { STATS_PERIODS, type StatsPeriodId, useStats } from './use-stats';

/** Which figure the daily chart plots. */
const DAILY_METRICS = [
  { id: 'cost', label: 'Spend' },
  { id: 'tokens', label: 'Tokens' },
] as const;

type DailyMetricId = (typeof DAILY_METRICS)[number]['id'];

/**
 * What the app has cost, and where it went.
 *
 * Every figure is summed on the DAEMON from its usage ledger — a table that
 * deliberately outlives the runs it accounts for, so tidying a chat away does
 * not quietly shrink the lifetime total.
 *
 * The page's one recurring rule: a figure nobody reported reads as
 * {@link NOT_MEASURED}, never as zero. cursor-agent reports no cost unless its
 * currency is USD and no cache, thinking or timing figures at all, so a page
 * that defaulted them would be making claims about money that no CLI ever made.
 * The charts keep the same rule by carrying nulls all the way in — a gap in a
 * line, an absent segment in a stack — rather than coalescing them on the way.
 */
export function Stats({
  handle,
  client = null,
}: {
  handle: DaemonHandle | null;
  /**
   * The live channel, so the figures follow the turns as they finish. The page
   * renders without it — it simply stops being live.
   */
  client?: DaemonClient | null;
}): React.JSX.Element {
  const apis = useMemo(
    () => (handle ? createDaemonApis(handle) : null),
    [handle],
  );
  const [period, setPeriod] = useState<StatsPeriodId>('30d');
  const [metric, setMetric] = useState<DailyMetricId>('cost');
  const { data, loading, error, reload, dismiss } = useStats(
    apis,
    period,
    client,
  );

  const points = useMemo(() => (data ? toDayPoints(data.days) : []), [data]);

  if (!handle) {
    return <EmptyState>Connecting to the daemon…</EmptyState>;
  }

  const totals = data?.totals;
  const perTurn =
    totals && totals.costedTurns > 0 && totals.costUsd !== null
      ? // Divided by the turns that actually REPORTED a cost, not by every turn:
        // a period mixing a CLI that prices its turns with one that does not
        // would otherwise report roughly half the true average.
        totals.costUsd / totals.costedTurns
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex flex-col gap-5 p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Stats</h2>
            <p className="text-sm text-muted-foreground">
              {data
                ? // The RESOLVED span, not the requested one. The daemon clamps
                  // a request to what the ledger can answer for, so a profile
                  // with three days of history that picks "90 days" gets three
                  // columns — indistinguishable from a quiet quarter unless the
                  // real period is on screen.
                  //
                  // Stated ONCE when both ends land on the same day, which
                  // Today makes ordinary and a fresh install already made
                  // reachable on every period: a span reading "Thursday, August
                  // 20, 2026 – Thursday, August 20, 2026" is a range that is
                  // not one, and the dash invites reading the halves as two
                  // different days.
                  dayRangeTitle(data.from, data.to)
                : 'What your agents have used, and what it cost.'}
            </p>
          </div>
          <SegmentedControl
            ariaLabel="Period"
            options={STATS_PERIODS}
            value={period}
            onSelect={setPeriod}
          />
        </header>

        {error ? (
          <ErrorBanner
            message={error}
            onDismiss={dismiss}
            action={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={reload}>
                Retry
              </Button>
            }
          />
        ) : null}

        {loading && !data ? (
          <EmptyState>Loading…</EmptyState>
        ) : data && totals ? (
          <>
            {/* The four figures somebody OPENS this page for, on one ruled
                surface. It replaced a hero card whose right two thirds were
                empty — "SPENT" at the far left, two small figures pinned to the
                far right, and a thousand pixels of nothing between them at any
                normal window width.

                Cost per turn and Agent time were MOVED up out of the grid
                below rather than repeated here: what a session costs and how
                long it took are headline answers, not two of eight token
                counts, and the note about rendering one figure twice inches
                apart is honoured by the move being a move.

                Type carries the emphasis, not a spanning cell — see
                `StatCell`'s `size`. */}
            <StatGrid className="grid-cols-2 lg:grid-cols-4">
              <StatCell
                size="lead"
                icon={Wallet}
                // Just "Spent" — the header directly above already states the
                // period this is the spend for.
                label="Spent"
                value={formatOrDash(totals.costUsd, formatUsd)}
              />
              <StatCell
                size="lead"
                icon={TrendingDown}
                label="Cost per turn"
                value={formatOrDash(perTurn, formatUsd)}
                footnote={
                  // Stated whenever the two differ, because the denominator is
                  // then not the turn count sitting beside it, and an average
                  // whose divisor is a mystery invites the reader to recompute
                  // it and find a different number.
                  totals.costedTurns === totals.turns
                    ? undefined
                    : `over ${formatCount(totals.costedTurns)} costed turns`
                }
              />
              <StatCell
                size="lead"
                icon={Repeat2}
                label="Turns"
                value={formatCount(totals.turns)}
              />
              <StatCell
                size="lead"
                icon={Clock}
                label="Agent time"
                value={formatOrDash(totals.workedMs, formatDuration)}
              />
            </StatGrid>

            {/* REPORTED as "move those to the top". The measured figures sit
                directly under the headline they qualify, where they read as the
                rest of the answer to "what did this cost" — before, they were
                the LAST thing on the page, three full sections and a scroll
                below the number they belong to.

                SIX cells now, not eight, and six is what makes the block
                divide: three columns is 3+3 and two is 2+2+2, so there is no
                breakpoint at which this grid ends in a ragged tail. Eight had
                one at every breakpoint but four. It is also one coherent
                subject — where the tokens went — rather than the mixed bag the
                eight were, the two that were about money and time having gone
                up into the summary where they belong. */}
            <StatGrid className="grid-cols-2 lg:grid-cols-3">
              <StatCell
                icon={HardDriveDownload}
                label="Tokens in"
                value={formatOrDash(totals.inputTokens, formatTokens)}
              />
              <StatCell
                icon={MessagesSquare}
                label="Tokens out"
                value={formatOrDash(totals.outputTokens, formatTokens)}
              />
              <StatCell
                icon={DatabaseZap}
                label="Cache read"
                value={formatOrDash(totals.cacheReadTokens, formatTokens)}
              />
              <StatCell
                icon={PiggyBank}
                label="Cache written"
                value={formatOrDash(totals.cacheCreationTokens, formatTokens)}
              />
              <StatCell
                icon={Brain}
                label="Thinking"
                value={formatOrDash(totals.thinkingTokens, formatTokens)}
              />
              <StatCell
                icon={Gauge}
                label="Cache hit rate"
                value={formatOrDash(
                  cacheHitRate(totals.cacheReadTokens, totals.inputTokens),
                  formatPercent,
                )}
                hint="Share of prompt tokens served from cache — the difference between a cheap session and an expensive one."
              />
            </StatGrid>

            <ChartPanel
              title="Per day"
              control={
                <SegmentedControl
                  ariaLabel="Daily metric"
                  options={DAILY_METRICS}
                  value={metric}
                  onSelect={setMetric}
                />
              }>
              <DailySeriesChart points={points} metric={metric} />
            </ChartPanel>

            {/* ONE ruled surface, four columns — not four cards. A grid of
                cards stretches every one to the tallest, so a breakdown that
                held a single row was a 345px box
                with 300px of nothing inside it, and the agent one beside it was
                another. The air is unavoidable while the columns are ranked
                lists of different lengths; drawing four boxes around it is not. */}
            <StatGrid className="sm:grid-cols-2 xl:grid-cols-4">
              <BreakdownColumn
                title="By agent"
                groups={data.byAgent}
                labelOf={(key) => key ?? 'Unattributed'}
                emptyLabel="No agent activity in this period."
              />
              <BreakdownColumn
                title="By model"
                groups={data.byModel}
                // The model the CLI REPORTED running each turn on, so a null
                // is a turn that named none — never a model called "CLI
                // default", which is what this row used to claim.
                labelOf={(key) => key ?? 'Model not reported'}
                emptyLabel="No model activity in this period."
              />
              <BreakdownColumn
                title="By project"
                groups={data.byProject}
                labelOf={(key) =>
                  key === null ? 'Unknown folder' : shortenPath(key, 2)
                }
                emptyLabel="No project activity in this period."
              />
              <BreakdownColumn
                title="By thread"
                groups={data.byThread}
                // A thread is keyed by its run id, so it is named by its own
                // title — and one deleted since keeps its spend and says so.
                // It replaced a per-workflow column whose null key pooled
                // every chat into one row.
                labelOf={threadLabel}
                titleOf={(group) => threadLabel(group.key, group)}
                emptyLabel="No thread activity in this period."
              />
            </StatGrid>

            <section className="grid gap-4 lg:grid-cols-2">
              <ChartPanel
                title="Cumulative spend"
                caption="The running total across the period.">
                <CumulativeSpendChart points={points} />
              </ChartPanel>
              <ChartPanel
                title="Tokens in vs out"
                caption="Prompt tokens against completion tokens, per day.">
                <TokenSplitChart points={points} />
              </ChartPanel>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** A titled chart surface — the one frame all four charts sit in. */
function ChartPanel({
  title,
  caption,
  control,
  children,
}: {
  title: string;
  caption?: string;
  control?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card className="min-w-0">
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-sm font-medium">{title}</h3>
            {caption ? (
              <p className="text-xs text-muted-foreground">{caption}</p>
            ) : null}
          </div>
          {control}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** How one thread's row reads: its title, or why it has none. */
function threadLabel(
  _key: string | null,
  group: { title?: string | null; deleted?: boolean },
): string {
  return group.title ?? (group.deleted ? 'Deleted thread' : 'Untitled thread');
}

/** A measured figure, or the not-measured mark. */
function formatOrDash(
  value: number | null,
  format: (value: number) => string,
): string {
  return value === null ? NOT_MEASURED : format(value);
}
