import { cva } from 'class-variance-authority';
import { ChevronRight } from 'lucide-react';

import { cn } from './ui/utils';

export const deltaTone = cva('border-transparent', {
  variants: {
    direction: {
      better: 'bg-success/10 text-success',
      worse: 'bg-destructive/10 text-destructive',
    },
  },
});

const deltaFill = cva('absolute inset-y-0 left-0 rounded-full', {
  variants: {
    direction: { better: 'bg-success', worse: 'bg-destructive' },
  },
});

const versionTag = cva('shrink-0 rounded px-1 font-mono text-[10px]', {
  variants: {
    current: {
      true: 'bg-primary/10 text-primary',
      false: 'bg-muted text-muted-foreground',
    },
  },
});

export interface RecommendationsLook {
  formatMs: (ms: number) => string;
  formatUsd: (usd: number) => string;
  formatPercent: (rate: number) => string;
  sinkColor: (index: number) => string;
}

export interface RecommendationsFolds {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
}

export interface WorkflowRunStatsView {
  runId: string;
  title: string | null;
  createdAt: string;
  version: number | null;
  current: boolean;
  wallMs: number;
  activeMs: number;
  waitingOnUserMs: number;
  turns: number;
  failedTurns: number;
  costUsd: number | null;
}

export interface WorkflowModelStatsView {
  agent: string | null;
  model: string | null;
  modelSource: 'reported' | 'configured' | 'unreported';
  turns: number;
  failedTurns: number;
  cancelledTurns: number;
  avgTurnMs: number | null;
  costUsd: number | null;
  costPerTurnUsd: number | null;
}

export interface WorkflowAgentStatsView {
  node: string;
  agent: string | null;
  runs: number;
  turns: number;
  failedTurns: number;
  cancelledTurns: number;
  workedMs: number | null;
  workedPerRunMs: number | null;
  waitingOnCalleePerRunMs: number | null;
  criticalPathPerRunMs: number | null;
  toolCalls: number;
  failedToolCalls: number;
  costUsd: number | null;
  costPerRunUsd: number | null;
  models: WorkflowModelStatsView[];
}

export interface WorkflowCallStatsView {
  caller: string;
  callee: string;
  calls: number;
  failedCalls: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
}

export interface WorkflowStatsView {
  runs: number;
  perRun: {
    wallMs: number;
    activeMs: number;
    waitingOnUserMs: number;
    criticalPathMs: number;
    turns: number;
    calls: number;
    costUsd: number | null;
    pricedRuns: number;
  };
  totals: {
    wallMs: number;
    activeMs: number;
    turns: number;
    failedTurns: number;
    cancelledTurns: number;
    toolCalls: number;
    failedToolCalls: number;
    calls: number;
    costUsd: number | null;
  };
  runList: WorkflowRunStatsView[];
  agents: WorkflowAgentStatsView[];
  callEdges: number;
  calls: WorkflowCallStatsView[];
}

const NOT_MEASURED = '—';

const SHOWN_AGENTS = 6;

export function SectionTitle({
  children,
  aside,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <h3 className="m-0 shrink-0 text-[11px] font-semibold tracking-wide text-foreground/80 uppercase">
        {children}
      </h3>
      {aside === undefined ? null : (
        <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground">
          {aside}
        </span>
      )}
    </div>
  );
}

export function Disclosure({
  label,
  open,
  onToggle,
  children,
}: {
  label: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex items-center gap-1 rounded-md px-1 text-[11px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3 transition-transform', open && 'rotate-90')}
        />
        {label}
      </button>
      {open ? <div className="pt-1 pl-4">{children}</div> : null}
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  tone = 'default',
}: {
  label: string;
  value: string;
  note: string | null;
  tone?: 'default' | 'bad';
}): React.JSX.Element {
  return (
    <div
      data-slot="analysis-tile"
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2">
      <span className="truncate text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          'truncate text-xl leading-none font-semibold tabular-nums',
          tone === 'bad' && 'text-destructive',
        )}>
        {value}
      </span>
      {note === null ? null : (
        <span className="text-[11px] leading-snug break-words text-muted-foreground">
          {note}
        </span>
      )}
    </div>
  );
}

function usdOrDash(look: RecommendationsLook, usd: number | null): string {
  return usd === null ? NOT_MEASURED : look.formatUsd(usd);
}

function msOrDash(look: RecommendationsLook, ms: number | null): string {
  return ms === null ? NOT_MEASURED : look.formatMs(ms);
}

function runsWord(count: number): string {
  return `${count} run${count === 1 ? '' : 's'}`;
}

function Scorecard({
  stats,
  look,
}: {
  stats: WorkflowStatsView;
  look: RecommendationsLook;
}): React.JSX.Element {
  const { perRun, totals } = stats;
  const unpriced = stats.runs - perRun.pricedRuns;
  return (
    <div
      data-slot="analysis-scorecard"
      className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2">
      <Tile
        label="Time per run"
        value={look.formatMs(perRun.wallMs)}
        note={`average of ${runsWord(stats.runs)} · agents active ${look.formatMs(perRun.activeMs)}`}
      />
      <Tile
        label="Cost per run"
        value={usdOrDash(look, perRun.costUsd)}
        note={
          totals.costUsd === null
            ? 'no run reported a cost'
            : `${look.formatUsd(totals.costUsd)} in all${unpriced > 0 ? ` · ${unpriced} unpriced` : ''}`
        }
      />
      <Tile
        label="Failed turns"
        value={String(totals.failedTurns)}
        tone={totals.failedTurns > 0 ? 'bad' : 'default'}
        note={`of ${totals.turns} turns · ${totals.failedToolCalls} of ${totals.toolCalls} tool calls failed`}
      />
      <Tile
        label="Waiting on you"
        value={look.formatMs(perRun.waitingOnUserMs)}
        note={`per run · critical path ${look.formatMs(perRun.criticalPathMs)}`}
      />
    </div>
  );
}

function topModel(agent: WorkflowAgentStatsView): string | null {
  const named = agent.models.filter((model) => model.model !== null);
  if (named.length === 0) {
    return null;
  }
  const extra = named.length - 1;
  return extra > 0 ? `${named[0]!.model} +${extra}` : named[0]!.model;
}

function AgentRow({
  agent,
  index,
  share,
  runs,
  look,
  hot,
}: {
  agent: WorkflowAgentStatsView;
  index: number;
  share: number | null;
  runs: number;
  look: RecommendationsLook;
  hot: boolean;
}): React.JSX.Element {
  const color = look.sinkColor(index);
  const model = topModel(agent);
  const perRun = agent.workedPerRunMs;
  const details = [
    agent.criticalPathPerRunMs === null || agent.criticalPathPerRunMs === 0
      ? null
      : `${look.formatMs(agent.criticalPathPerRunMs)} on the critical path`,
    agent.waitingOnCalleePerRunMs === null ||
    agent.waitingOnCalleePerRunMs === 0
      ? null
      : `${look.formatMs(agent.waitingOnCalleePerRunMs)} blocked on callees`,
    `${agent.turns} turn${agent.turns === 1 ? '' : 's'}${agent.failedTurns > 0 ? `, ${agent.failedTurns} failed` : ''}`,
    `${agent.toolCalls} tool call${agent.toolCalls === 1 ? '' : 's'}${agent.failedToolCalls > 0 ? `, ${agent.failedToolCalls} failed` : ''}`,
    agent.runs < runs ? `in ${agent.runs} of ${runsWord(runs)}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <li
      data-slot="analysis-agent"
      data-node={agent.node}
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-md px-1.5 py-1',
        hot && 'bg-muted/60',
      )}>
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 translate-y-[-1px] rounded-full"
          style={{ background: color }}
        />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate font-medium">{agent.node}</span>
          {model === null ? null : (
            <span
              className="truncate text-[11px] text-muted-foreground"
              title={agent.agent ?? undefined}>
              {model}
            </span>
          )}
        </span>
        <span className="shrink-0 font-medium tabular-nums">
          {perRun === null ? NOT_MEASURED : `${look.formatMs(perRun)}/run`}
        </span>
        <span
          className="w-9 shrink-0 text-right text-muted-foreground tabular-nums"
          title="Share of every agent's working time">
          {share === null ? NOT_MEASURED : look.formatPercent(share * 100)}
        </span>
        <span className="w-[4.5rem] shrink-0 text-right text-muted-foreground tabular-nums">
          {agent.costPerRunUsd === null
            ? NOT_MEASURED
            : `${look.formatUsd(agent.costPerRunUsd)}/run`}
        </span>
      </div>
      <div className="ml-4 h-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${Math.min(100, Math.max(0, (share ?? 0) * 100))}%`,
            background: color,
          }}
        />
      </div>
      <p className="m-0 ml-4 text-[11px] leading-snug text-muted-foreground">
        {details.join(' · ')}
      </p>
    </li>
  );
}

function WhereTheTimeGoes({
  stats,
  look,
  folds,
  hotNodes,
}: {
  stats: WorkflowStatsView;
  look: RecommendationsLook;
  folds: RecommendationsFolds;
  hotNodes: ReadonlySet<string>;
}): React.JSX.Element | null {
  const worked = stats.agents.reduce(
    (total, agent) => total + (agent.workedMs ?? 0),
    0,
  );
  if (stats.agents.length === 0) {
    return null;
  }
  const showAll = folds.isOpen('agents:all');
  const shown = showAll ? stats.agents : stats.agents.slice(0, SHOWN_AGENTS);
  return (
    <section
      data-slot="analysis-where-time-goes"
      className="flex min-w-0 flex-col gap-1.5">
      <SectionTitle aside="time · share · cost, per run">
        Where the time goes
      </SectionTitle>
      {worked === 0 ? null : (
        <div
          role="img"
          aria-label={`Working time by agent: ${stats.agents
            .filter((agent) => (agent.workedMs ?? 0) > 0)
            .map(
              (agent) =>
                `${agent.node} ${look.formatPercent(((agent.workedMs ?? 0) / worked) * 100)}`,
            )
            .join(', ')}`}
          className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted">
          {stats.agents.map((agent, index) =>
            (agent.workedMs ?? 0) <= 0 ? null : (
              <span
                key={agent.node}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${((agent.workedMs ?? 0) / worked) * 100}%`,
                  background: look.sinkColor(index),
                }}
              />
            ),
          )}
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {shown.map((agent) => {
          const index = stats.agents.indexOf(agent);
          return (
            <AgentRow
              key={agent.node}
              agent={agent}
              index={index}
              share={workedShare(stats, agent)}
              runs={stats.runs}
              look={look}
              hot={hotNodes.has(agent.node)}
            />
          );
        })}
      </ul>
      {stats.agents.length <= SHOWN_AGENTS ? null : (
        <button
          type="button"
          onClick={() => folds.toggle('agents:all')}
          className="self-start rounded-md px-1 text-[11px] font-medium text-muted-foreground hover:text-foreground">
          {showAll
            ? 'Show fewer agents'
            : `Show all ${stats.agents.length} agents`}
        </button>
      )}
    </section>
  );
}

const CELL = 'px-1.5 py-1 text-right tabular-nums whitespace-nowrap';
const HEAD =
  'px-1.5 pb-1 text-right font-medium whitespace-nowrap text-muted-foreground';

function ModelsTable({
  stats,
  look,
}: {
  stats: WorkflowStatsView;
  look: RecommendationsLook;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table
        data-slot="analysis-models"
        className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className={cn(HEAD, 'text-left')}>Agent</th>
            <th className={cn(HEAD, 'text-left')}>Model</th>
            <th className={HEAD}>Turns</th>
            <th className={HEAD}>Failed</th>
            <th className={HEAD}>Avg turn</th>
            <th className={HEAD}>Per turn</th>
          </tr>
        </thead>
        <tbody>
          {stats.agents.flatMap((agent) =>
            agent.models.map((model, index) => (
              <tr
                key={`${agent.node}:${model.agent ?? ''}:${model.model ?? ''}:${model.modelSource}`}
                className="border-t border-border/60">
                <td className="px-1.5 py-1 font-medium whitespace-nowrap">
                  {index === 0 ? agent.node : ''}
                </td>
                <td
                  className="px-1.5 py-1 whitespace-nowrap text-muted-foreground"
                  title={
                    model.modelSource === 'configured'
                      ? 'Turns that ended before the agent reported its model — the model the workflow configured'
                      : model.modelSource === 'unreported'
                        ? 'Pooled turns that named no member'
                        : undefined
                  }>
                  {model.model ??
                    (model.modelSource === 'unreported'
                      ? 'unreported'
                      : 'CLI default')}
                  {model.modelSource === 'configured' ? '*' : ''}
                </td>
                <td className={CELL}>{model.turns}</td>
                <td
                  className={cn(
                    CELL,
                    model.failedTurns > 0 && 'text-destructive',
                  )}>
                  {model.failedTurns + model.cancelledTurns === 0
                    ? '0'
                    : `${model.failedTurns}${model.cancelledTurns > 0 ? ` +${model.cancelledTurns} stopped` : ''}`}
                </td>
                <td className={CELL}>{msOrDash(look, model.avgTurnMs)}</td>
                <td className={CELL}>
                  {usdOrDash(look, model.costPerTurnUsd)}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

function runLabel(run: WorkflowRunStatsView): string {
  return (
    run.title ??
    new Date(run.createdAt).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  );
}

function RunsList({
  stats,
  look,
}: {
  stats: WorkflowStatsView;
  look: RecommendationsLook;
}): React.JSX.Element {
  const longest = Math.max(1, ...stats.runList.map((run) => run.wallMs));
  return (
    <ul
      data-slot="analysis-runs"
      className="m-0 flex list-none flex-col gap-1 p-0">
      {stats.runList.map((run) => (
        <li key={run.runId} className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-2 text-[11px]">
            <span className="min-w-0 flex-1 truncate" title={run.title ?? ''}>
              {runLabel(run)}
            </span>
            {run.version === null ? null : (
              <span
                className={versionTag({ current: run.current })}
                title={
                  run.current
                    ? 'Ran the workflow as it is now'
                    : 'Ran an earlier version'
                }>
                v{run.version}
              </span>
            )}
            {run.failedTurns === 0 ? null : (
              <span className="shrink-0 text-destructive tabular-nums">
                {run.failedTurns} failed
              </span>
            )}
            <span className="w-12 shrink-0 text-right font-medium tabular-nums">
              {look.formatMs(run.wallMs)}
            </span>
            <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
              {usdOrDash(look, run.costUsd)}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-muted-foreground/40"
              style={{ width: `${(run.wallMs / longest) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function CallsTable({
  stats,
  look,
}: {
  stats: WorkflowStatsView;
  look: RecommendationsLook;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table
        data-slot="analysis-calls"
        className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className={cn(HEAD, 'text-left')}>Caller → callee</th>
            <th className={HEAD}>Calls</th>
            <th className={HEAD}>Failed</th>
            <th className={HEAD}>Average</th>
            <th className={HEAD}>Longest</th>
            <th className={HEAD}>Total</th>
          </tr>
        </thead>
        <tbody>
          {stats.calls.map((call) => (
            <tr
              key={`${call.caller}→${call.callee}`}
              className="border-t border-border/60">
              <td className="px-1.5 py-1 whitespace-nowrap">
                {call.caller} → {call.callee}
              </td>
              <td className={CELL}>{call.calls}</td>
              <td
                className={cn(
                  CELL,
                  call.failedCalls > 0 && 'text-destructive',
                )}>
                {call.failedCalls}
              </td>
              <td className={CELL}>{look.formatMs(call.avgMs)}</td>
              <td className={CELL}>{look.formatMs(call.maxMs)}</td>
              <td className={CELL}>{look.formatMs(call.totalMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WorkflowFigures({
  stats,
  look,
  folds,
  hotNodes,
}: {
  stats: WorkflowStatsView;
  look: RecommendationsLook;
  folds: RecommendationsFolds;
  hotNodes: ReadonlySet<string>;
}): React.JSX.Element {
  const models = stats.agents.reduce(
    (total, agent) => total + agent.models.length,
    0,
  );
  return (
    <div data-slot="analysis-figures" className="flex min-w-0 flex-col gap-3">
      <Scorecard stats={stats} look={look} />
      <WhereTheTimeGoes
        stats={stats}
        look={look}
        folds={folds}
        hotNodes={hotNodes}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        {models === 0 ? null : (
          <Disclosure
            label={`Models · ${models}`}
            open={folds.isOpen('figures:models')}
            onToggle={() => folds.toggle('figures:models')}>
            <ModelsTable stats={stats} look={look} />
          </Disclosure>
        )}
        <Disclosure
          label={`Runs · ${stats.runList.length}`}
          open={folds.isOpen('figures:runs')}
          onToggle={() => folds.toggle('figures:runs')}>
          <RunsList stats={stats} look={look} />
        </Disclosure>
        {stats.calls.length === 0 ? null : (
          <Disclosure
            label={
              stats.callEdges > stats.calls.length
                ? `Calls between agents · longest ${stats.calls.length} of ${stats.callEdges}`
                : `Calls between agents · ${stats.calls.length}`
            }
            open={folds.isOpen('figures:calls')}
            onToggle={() => folds.toggle('figures:calls')}>
            <CallsTable stats={stats} look={look} />
          </Disclosure>
        )}
      </div>
    </div>
  );
}

export function workedShare(
  stats: WorkflowStatsView,
  agent: WorkflowAgentStatsView,
): number | null {
  const worked = stats.agents.reduce(
    (total, each) => total + (each.workedMs ?? 0),
    0,
  );
  return worked === 0 || agent.workedMs === null
    ? null
    : agent.workedMs / worked;
}

export type ProjectionUnit = 'run' | 'thread';

export interface ProjectionBaseline {
  wallMs: number | null;
  costUsd: number | null;
}

function signedDelta(
  change: number,
  format: (value: number) => string,
): string {
  if (change === 0) {
    return '±0';
  }
  return `${change < 0 ? '−' : '+'}${format(Math.abs(change))}`;
}

function ProjectionRow({
  label,
  before,
  after,
  format,
  look,
}: {
  label: string;
  before: number;
  after: number;
  format: (value: number) => string;
  look: RecommendationsLook;
}): React.JSX.Element {
  const longest = Math.max(before, after, 1e-9);
  const change = after - before;
  const rate = before === 0 ? 0 : (change / before) * 100;
  const better = change < 0;
  return (
    <div
      data-slot="analysis-projection-row"
      className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {format(before)}
        </span>
        <span aria-hidden="true" className="text-muted-foreground">
          →
        </span>
        <span className="font-semibold tabular-nums">{format(after)}</span>
        {change === 0 ? null : (
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[11px] leading-tight font-medium tabular-nums',
              deltaTone({ direction: better ? 'better' : 'worse' }),
            )}>
            {signedDelta(change, format)} · {better ? '−' : '+'}
            {look.formatPercent(Math.abs(rate))}
          </span>
        )}
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground/25"
          style={{ width: `${(before / longest) * 100}%` }}
        />
        <span
          className={deltaFill({ direction: better ? 'better' : 'worse' })}
          style={{ width: `${(after / longest) * 100}%` }}
        />
      </div>
    </div>
  );
}

export function RecommendationsProjection({
  baseline,
  minutesSaved,
  costSavedUsd,
  scope,
  unit = 'run',
  look,
}: {
  baseline: ProjectionBaseline;
  minutesSaved: number;
  costSavedUsd: number | null;
  scope: string;
  unit?: ProjectionUnit;
  look: RecommendationsLook;
}): React.JSX.Element | null {
  const savedMs = minutesSaved * 60_000;
  const rows: React.ReactNode[] = [];
  const loose: string[] = [];
  if (baseline.wallMs !== null) {
    rows.push(
      <ProjectionRow
        key="time"
        label={`Time per ${unit}`}
        before={baseline.wallMs}
        after={Math.max(0, baseline.wallMs - savedMs)}
        format={look.formatMs}
        look={look}
      />,
    );
  } else if (savedMs !== 0) {
    loose.push(`${signedDelta(-savedMs, look.formatMs)} per ${unit}`);
  }
  if (baseline.costUsd !== null && costSavedUsd !== null) {
    rows.push(
      <ProjectionRow
        key="cost"
        label={`Cost per ${unit}`}
        before={baseline.costUsd}
        after={Math.max(0, baseline.costUsd - costSavedUsd)}
        format={look.formatUsd}
        look={look}
      />,
    );
  } else if (costSavedUsd !== null && costSavedUsd !== 0) {
    loose.push(`${signedDelta(-costSavedUsd, look.formatUsd)} per ${unit}`);
  }
  if (rows.length === 0 && loose.length === 0) {
    return null;
  }
  return (
    <section
      data-slot="analysis-projection"
      className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/50 p-2.5">
      <SectionTitle aside={scope}>Projected per {unit}</SectionTitle>
      {rows}
      {loose.length === 0 ? null : (
        <p className="m-0 text-xs font-medium tabular-nums">
          {loose.join(' · ')}
        </p>
      )}
      <p className="m-0 text-[11px] leading-snug text-muted-foreground">
        From the analysis’s own estimates over the measured figures; items can
        overlap, so read it as the most they could save.
      </p>
    </section>
  );
}
