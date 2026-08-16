import {
  Brain,
  Clock,
  DatabaseZap,
  Gauge,
  HardDriveDownload,
  MessagesSquare,
  PiggyBank,
  TrendingDown,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { DaemonHandle } from '../../shared/contracts';
import { formatTokens, formatUsd } from '../chats/agent-activity';
import { shortenPath } from '../chats/directory-select';
import { EmptyState } from '../components/empty-state';
import { ErrorBanner } from '../components/error-banner';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { cn } from '../components/ui/utils';
import { createDaemonApis } from '../daemon-api';
import { BreakdownCard } from './breakdown-card';
import { toDayPoints } from './chart-data';
import {
  CumulativeSpendChart,
  DailySeriesChart,
  TokenSplitChart,
} from './charts/time-charts';
import { HeroStat, StatCard } from './stat-card';
import {
  cacheHitRate,
  formatDayTitle,
  formatDuration,
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
}: {
  handle: DaemonHandle | null;
}): React.JSX.Element {
  const apis = useMemo(
    () => (handle ? createDaemonApis(handle) : null),
    [handle],
  );
  const [period, setPeriod] = useState<StatsPeriodId>('30d');
  const [metric, setMetric] = useState<DailyMetricId>('cost');
  const { data, loading, error, reload, dismiss } = useStats(apis, period);

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
                  `${formatDayTitle(data.from.slice(0, 10))} – ${formatDayTitle(
                    data.to.slice(0, 10),
                  )}`
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
            <HeroStat
              // Just "Spent" — the header directly above already states the
              // period, and the cost-per-turn figure is deliberately NOT
              // repeated here: it has its own card below, and one figure
              // rendered twice inches apart is what the context readout was
              // already criticised for.
              caption="Spent"
              value={formatOrDash(totals.costUsd, formatUsd)}
              aside={[
                { label: 'Turns', value: String(totals.turns) },
                {
                  label: 'Tokens',
                  value: formatOrDash(
                    sumTokens(totals.inputTokens, totals.outputTokens),
                    formatTokens,
                  ),
                },
              ]}
            />

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

            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <BreakdownCard
                title="By agent"
                groups={data.byAgent}
                labelOf={(key) => key ?? 'Unattributed'}
                emptyLabel="No agent activity in this period."
              />
              <BreakdownCard
                title="By model"
                groups={data.byModel}
                labelOf={(key) => key ?? 'CLI default'}
                emptyLabel="No model activity in this period."
              />
              <BreakdownCard
                title="By project"
                groups={data.byProject}
                labelOf={(key) =>
                  key === null ? 'Unknown folder' : shortenPath(key, 2)
                }
                emptyLabel="No project activity in this period."
              />
              <BreakdownCard
                title="By workflow"
                groups={data.byWorkflow}
                // A null key is a single-agent chat, and it is named rather
                // than hidden: what the graphs cost is only meaningful beside
                // what the plain chats cost. Turns recorded before the ledger
                // stored a workflow name land here too — the name was never
                // written and cannot be recovered, and inventing one would be
                // worse than a row that says "not a workflow".
                labelOf={(key) => key ?? 'Chats'}
                emptyLabel="No workflow activity in this period."
              />
            </section>

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

            <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
              <StatCard
                icon={HardDriveDownload}
                label="Tokens in"
                value={formatOrDash(totals.inputTokens, formatTokens)}
              />
              <StatCard
                icon={MessagesSquare}
                label="Tokens out"
                value={formatOrDash(totals.outputTokens, formatTokens)}
              />
              <StatCard
                icon={DatabaseZap}
                label="Cache read"
                value={formatOrDash(totals.cacheReadTokens, formatTokens)}
              />
              <StatCard
                icon={PiggyBank}
                label="Cache written"
                value={formatOrDash(totals.cacheCreationTokens, formatTokens)}
              />
              <StatCard
                icon={Brain}
                label="Thinking"
                value={formatOrDash(totals.thinkingTokens, formatTokens)}
              />
              <StatCard
                icon={Clock}
                label="Agent time"
                value={formatOrDash(totals.workedMs, formatDuration)}
              />
              <StatCard
                icon={Gauge}
                label="Cache hit rate"
                value={formatOrDash(
                  cacheHitRate(totals.cacheReadTokens, totals.inputTokens),
                  (rate) => `${Math.round(rate)}%`,
                )}
                hint="Share of prompt tokens served from cache — the difference between a cheap session and an expensive one."
              />
              <StatCard
                icon={TrendingDown}
                label="Cost per turn"
                value={formatOrDash(perTurn, formatUsd)}
                footnote={
                  // Stated whenever the two differ, because the denominator is
                  // then not the turn count sitting directly above it, and an
                  // average whose divisor is a mystery invites the reader to
                  // recompute it and find a different number.
                  totals.costedTurns === totals.turns
                    ? undefined
                    : `over ${totals.costedTurns} costed turns`
                }
              />
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

/**
 * Input + output where either was reported, null where neither was.
 *
 * A plain `(a ?? 0) + (b ?? 0)` would turn a period nobody measured into a
 * measured zero, which is the one substitution this page exists not to make.
 */
function sumTokens(input: number | null, output: number | null): number | null {
  if (input === null && output === null) {
    return null;
  }
  return (input ?? 0) + (output ?? 0);
}

/** A measured figure, or the not-measured mark. */
function formatOrDash(
  value: number | null,
  format: (value: number) => string,
): string {
  return value === null ? NOT_MEASURED : format(value);
}

/**
 * A small run of mutually exclusive options.
 *
 * Not `select`: there are two to four choices, they are always worth showing,
 * and switching between them is the main thing a reader does on this page — a
 * dropdown would hide them behind a click each time. Kept local to this screen
 * rather than promoted to `components/`, since nothing else uses one yet.
 */
function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onSelect,
}: {
  ariaLabel: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onSelect: (id: T) => void;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex items-center gap-1 rounded-md border border-border bg-muted p-1">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          onClick={() => onSelect(option.id)}
          className={cn(
            'rounded-sm px-3 py-1 text-sm font-medium outline-none transition-colors',
            'focus-visible:ring-2 focus-visible:ring-ring/50',
            option.id === value
              ? 'bg-card text-foreground shadow-panel-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
