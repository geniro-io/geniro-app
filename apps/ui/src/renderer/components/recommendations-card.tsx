import { cva } from 'class-variance-authority';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { ErrorBanner } from './error-banner';
import {
  deltaTone,
  Disclosure,
  type ProjectionUnit,
  type RecommendationsFolds,
  type RecommendationsLook,
  RecommendationsProjection,
  SectionTitle,
  workedShare,
  type WorkflowAgentStatsView,
  WorkflowFigures,
  type WorkflowStatsView,
} from './recommendations-figures';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { OptionIndicator } from './ui/option-list';
import { cn } from './ui/utils';

export type {
  RecommendationsFolds,
  RecommendationsLook,
  WorkflowStatsView,
} from './recommendations-figures';

export type RecommendationRisk = 'low' | 'medium' | 'high';
export type RecommendationTerritory = 'process' | 'domain';
export type RecommendationOutcomeStatus = 'applied' | 'skipped' | 'failed';

/** One recommendation as the card draws it. */
export interface RecommendationView {
  id: string;
  target: 'workflow' | 'repo' | 'user' | 'memory';
  territory: RecommendationTerritory;
  kind: string;
  location: string;
  title: string;
  change: string;
  evidence: {
    /** The run the quote is from — a workflow analysis reads several. */
    runId?: string | null;
    seq: number;
    ts: string | null;
    nodeId: string | null;
    quote: string;
  }[];
  rootCause: string;
  minutesSaved: number;
  costSavedUsd: number | null;
  outcome: string | null;
  basis: string;
  confidence: number;
  risk: RecommendationRisk;
  riskNote: string;
}

export interface RecommendationHotspotView {
  title: string;
  node: string | null;
  why: string;
  items: string[];
}

/** The summary strip — every figure measured by the daemon. */
export interface RecommendationsTimingView {
  wallMs: number;
  activeMs: number;
  waitingMs: number;
  criticalPathMs: number;
  sinks: { label: string; ms: number }[];
}

export interface RecommendationOutcomeView {
  status: RecommendationOutcomeStatus;
  note: string | null;
  backup: string | null;
}

/** An agent's clause, closed once: it may or may not end its own sentence. */
function sentence(text: string): string {
  const trimmed = text.trimEnd();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const RISK_BADGE: Record<
  RecommendationRisk,
  { variant: 'muted' | 'secondary' | 'destructive'; label: string }
> = {
  low: { variant: 'muted', label: 'low risk' },
  medium: { variant: 'secondary', label: 'medium risk' },
  high: { variant: 'destructive', label: 'high risk' },
};

const TERRITORY_BADGE: Record<
  RecommendationTerritory,
  { label: string; hint: string }
> = {
  process: {
    label: 'process',
    hint: 'How the agents work: commands, retries, reading order, hand-offs, running the checks they have, parallelism, model and effort',
  },
  domain: {
    label: 'domain',
    hint: 'What the work itself needs to know: the project’s facts, procedures and constraints',
  },
};

const OUTCOME_BADGE: Record<
  RecommendationOutcomeStatus,
  { variant: 'success' | 'muted' | 'destructive'; label: string }
> = {
  applied: { variant: 'success', label: 'Applied' },
  skipped: { variant: 'muted', label: 'Skipped' },
  failed: { variant: 'destructive', label: 'Failed' },
};

/**
 * Where the card's ticked items are kept until Apply — per thread, by the
 * caller, so a row redrawn before Apply keeps them; absent keeps them for
 * the card's own life.
 */
export interface RecommendationsSelection {
  picked: readonly string[];
  setPicked: (ids: readonly string[]) => void;
}

function minutesDelta(
  minutes: number,
  look: RecommendationsLook,
  unit: ProjectionUnit,
): string {
  const ms = Math.abs(minutes) * 60_000;
  return `${minutes > 0 ? '−' : '+'}${look.formatMs(ms)}/${unit}`;
}

function usdDelta(
  usd: number,
  look: RecommendationsLook,
  unit: ProjectionUnit,
): string {
  return `${usd > 0 ? '−' : '+'}${look.formatUsd(Math.abs(usd))}/${unit}`;
}

const fixToggle = cva(
  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default',
  {
    variants: {
      on: {
        true: 'border-primary/40 bg-primary/10 text-primary',
        false:
          'border-border text-muted-foreground enabled:hover:text-foreground',
      },
    },
  },
);

function TimingStrip({
  timing,
  look,
}: {
  timing: RecommendationsTimingView;
  look: RecommendationsLook;
}): React.JSX.Element {
  const total = Math.max(1, timing.wallMs);
  const sinks = timing.sinks.filter((sink) => sink.ms > 0);
  return (
    <div data-slot="recommendations-timing" className="flex flex-col gap-1.5">
      <dl className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {(
          [
            ['Wall', timing.wallMs],
            ['Active', timing.activeMs],
            ['Waiting on you', timing.waitingMs],
            ['Critical path', timing.criticalPathMs],
          ] as const
        ).map(([label, ms]) => (
          <div key={label} className="flex items-baseline gap-1">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="m-0 font-medium tabular-nums">
              {look.formatMs(ms)}
            </dd>
          </div>
        ))}
      </dl>
      {sinks.length === 0 ? null : (
        <>
          <div
            role="img"
            aria-label={`Where the critical path went: ${sinks
              .map((sink) => `${sink.label} ${look.formatMs(sink.ms)}`)
              .join(', ')}`}
            className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
            {sinks.map((sink, index) => (
              <span
                key={sink.label}
                className="h-full"
                style={{
                  width: `${Math.min(100, (sink.ms / total) * 100)}%`,
                  background: look.sinkColor(index),
                }}
              />
            ))}
          </div>
          <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0 text-[11px] text-muted-foreground">
            {sinks.map((sink, index) => (
              <li key={sink.label} className="flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full"
                  style={{ background: look.sinkColor(index) }}
                />
                {sink.label} · {look.formatMs(sink.ms)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ItemRow({
  item,
  selected,
  locked,
  outcome,
  queued,
  folds,
  look,
  unit,
  onToggle,
}: {
  item: RecommendationView;
  selected: boolean;
  locked: boolean;
  outcome: RecommendationOutcomeView | null;
  queued: boolean;
  folds: RecommendationsFolds;
  look: RecommendationsLook;
  unit: ProjectionUnit;
  onToggle: () => void;
}): React.JSX.Element {
  const risk = RISK_BADGE[item.risk];
  const territory = TERRITORY_BADGE[item.territory];
  const result = outcome === null ? null : OUTCOME_BADGE[outcome.status];
  return (
    <li
      data-slot="recommendation-row"
      data-id={item.id}
      className="flex min-w-0 flex-col gap-1 rounded-md px-1 py-1.5">
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`${item.id} ${item.title}`}
          disabled={locked}
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default">
          <OptionIndicator arity="many" chosen={selected} />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-sm break-words">
              <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                {item.id}
              </span>
              {item.title}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              <Badge
                variant="muted"
                title={territory.hint}
                data-slot="recommendation-territory">
                {territory.label}
              </Badge>
              <Badge variant="outline">{item.kind}</Badge>
              {item.minutesSaved === 0 ? null : (
                <Badge
                  data-slot="recommendation-time"
                  className={deltaTone({
                    direction: item.minutesSaved > 0 ? 'better' : 'worse',
                  })}>
                  {minutesDelta(item.minutesSaved, look, unit)}
                </Badge>
              )}
              {item.costSavedUsd === null || item.costSavedUsd === 0 ? null : (
                <Badge
                  data-slot="recommendation-cost"
                  className={deltaTone({
                    direction: item.costSavedUsd > 0 ? 'better' : 'worse',
                  })}>
                  {usdDelta(item.costSavedUsd, look, unit)}
                </Badge>
              )}
              <Badge variant="muted">confidence {item.confidence}/5</Badge>
              <Badge variant={risk.variant}>{risk.label}</Badge>
              {result ? (
                <Badge
                  variant={result.variant}
                  data-slot="recommendation-outcome">
                  {result.label}
                </Badge>
              ) : queued ? (
                <Badge variant="muted" data-slot="recommendation-outcome">
                  Queued
                </Badge>
              ) : null}
            </span>
            {item.outcome === null ? null : (
              <span
                data-slot="recommendation-expected"
                className="flex items-start gap-1 text-xs leading-snug text-foreground/80">
                <ArrowRight
                  aria-hidden="true"
                  className="mt-0.5 size-3 shrink-0 text-success"
                />
                <span className="min-w-0 break-words">{item.outcome}</span>
              </span>
            )}
          </span>
        </button>
      </div>
      {outcome !== null &&
      (outcome.note !== null || outcome.backup !== null) ? (
        <p className="m-0 pl-6 text-xs text-muted-foreground">
          {[
            outcome.note,
            outcome.backup === null ? null : `backup: ${outcome.backup}`,
          ]
            .filter((part): part is string => part !== null)
            .join(' · ')}
        </p>
      ) : null}
      <div className="flex flex-col gap-0.5 pl-5">
        <Disclosure
          label="Why"
          open={folds.isOpen(`${item.id}:why`)}
          onToggle={() => folds.toggle(`${item.id}:why`)}>
          <div className="flex flex-col gap-1.5 text-xs leading-relaxed">
            <p className="m-0">{item.rootCause}</p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {item.evidence.map((evidence, index) => (
                <li key={`${evidence.seq}:${index}`} className="min-w-0">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {[
                      evidence.runId == null
                        ? null
                        : `run ${evidence.runId.slice(0, 8)}`,
                      `seq ${evidence.seq}`,
                      evidence.nodeId,
                      evidence.ts,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(' · ')}
                  </span>
                  <blockquote className="m-0 border-l-2 border-border pl-2 break-words text-muted-foreground">
                    {evidence.quote}
                  </blockquote>
                </li>
              ))}
            </ul>
            <p className="m-0 text-muted-foreground">
              Estimate: {sentence(item.basis)} If wrong: {item.riskNote}
            </p>
          </div>
        </Disclosure>
        <Disclosure
          label="Change"
          open={folds.isOpen(`${item.id}:change`)}
          onToggle={() => folds.toggle(`${item.id}:change`)}>
          <p className="m-0 mb-1 font-mono text-[11px] text-muted-foreground">
            {item.location}
          </p>
          <pre className="m-0 max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
            {item.change}
          </pre>
        </Disclosure>
      </div>
    </li>
  );
}

function HotspotFigures({
  agent,
  stats,
  look,
}: {
  agent: WorkflowAgentStatsView;
  stats: WorkflowStatsView;
  look: RecommendationsLook;
}): React.JSX.Element {
  const share = workedShare(stats, agent);
  return (
    <p
      data-slot="analysis-hotspot-figures"
      className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
      <span className="font-medium text-foreground">{agent.node}</span>
      {agent.workedPerRunMs === null ? null : (
        <span>{look.formatMs(agent.workedPerRunMs)}/run</span>
      )}
      {share === null ? null : (
        <span>{look.formatPercent(share * 100)} of the agents’ time</span>
      )}
      {agent.costPerRunUsd === null ? null : (
        <span>{look.formatUsd(agent.costPerRunUsd)}/run</span>
      )}
      {agent.failedTurns === 0 ? null : (
        <span className="text-destructive">
          {agent.failedTurns} failed turn{agent.failedTurns === 1 ? '' : 's'}
        </span>
      )}
    </p>
  );
}

function Hotspots({
  hotspots,
  stats,
  items,
  selected,
  locked,
  look,
  onToggle,
}: {
  hotspots: readonly RecommendationHotspotView[];
  stats: WorkflowStatsView | null;
  items: readonly RecommendationView[];
  selected: readonly string[];
  locked: boolean;
  look: RecommendationsLook;
  onToggle: (id: string) => void;
}): React.JSX.Element {
  return (
    <section
      data-slot="analysis-hotspots"
      className="flex min-w-0 flex-col gap-2">
      <SectionTitle>What costs the most, and why</SectionTitle>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {hotspots.map((hotspot, index) => {
          const agent =
            hotspot.node === null
              ? null
              : (stats?.agents.find((each) => each.node === hotspot.node) ??
                null);
          const fixes = hotspot.items.flatMap((id) => {
            const item = items.find((each) => each.id === id);
            return item === undefined ? [] : [item];
          });
          return (
            <li
              key={`${index}:${hotspot.title}`}
              data-slot="analysis-hotspot"
              className="flex min-w-0 gap-2.5">
              <span
                aria-hidden="true"
                className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary tabular-nums">
                {index + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="m-0 text-sm font-medium break-words">
                  {hotspot.title}
                </p>
                {agent === null || stats === null ? null : (
                  <HotspotFigures agent={agent} stats={stats} look={look} />
                )}
                <p className="m-0 text-xs leading-relaxed break-words text-muted-foreground">
                  {hotspot.why}
                </p>
                {fixes.length === 0 ? null : (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[11px] text-muted-foreground">
                      Fixed by
                    </span>
                    {fixes.map((item) => {
                      const on = selected.includes(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          data-slot="analysis-hotspot-fix"
                          aria-pressed={on}
                          disabled={locked}
                          title={item.title}
                          onClick={() => onToggle(item.id)}
                          className={fixToggle({ on })}>
                          {on ? (
                            <Check aria-hidden="true" className="size-3" />
                          ) : null}
                          {item.id}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function projectionScope(
  kept: readonly string[] | null,
  picked: readonly string[],
  total: number,
): string {
  if (kept !== null) {
    return kept.length === 0
      ? 'nothing applied'
      : `with the ${kept.length} applied`;
  }
  if (picked.length > 0) {
    return `with the ${picked.length} selected`;
  }
  return total === 1 ? 'with the recommendation' : `with all ${total}`;
}

/**
 * An analysis's card: what the analysed runs took, where the time and money
 * went and why, the changes it suggests — each one ticked or left and then
 * applied together — and what the runs would take with them.
 *
 * Three states, read from the props rather than held here: selecting (no Apply
 * sent yet), applying (an Apply was sent and some of its items have no outcome
 * yet), applied (every selected item has one). Only the first takes a press —
 * an Apply is sent once.
 */
export function RecommendationsCard({
  summary,
  timing,
  workflowStats = null,
  hotspots = [],
  workflow,
  items,
  applied,
  outcomes,
  sending = false,
  error = null,
  look,
  folds,
  selection,
  onApply,
  onDismissError,
}: {
  summary: string | null;
  timing: RecommendationsTimingView | null;
  workflowStats?: WorkflowStatsView | null;
  hotspots?: readonly RecommendationHotspotView[];
  /** The analysed thread is a workflow; a plain chat gets no Workflow group. */
  workflow: boolean;
  items: readonly RecommendationView[];
  /** The ids the Apply sent, or null while none has been. */
  applied: readonly string[] | null;
  outcomes: Readonly<Record<string, RecommendationOutcomeView>>;
  /** The Apply is on its way to the daemon. */
  sending?: boolean;
  error?: string | null;
  look: RecommendationsLook;
  folds?: RecommendationsFolds;
  selection?: RecommendationsSelection;
  /** Absent draws the card read-only (no Apply). */
  onApply?: (ids: string[]) => void;
  onDismissError?: () => void;
}): React.JSX.Element {
  const [localPicked, setLocalPicked] = useState<readonly string[]>([]);
  const picked = selection?.picked ?? localPicked;
  const setPicked = selection?.setPicked ?? setLocalPicked;
  const [localFolds, setLocalFolds] = useState<ReadonlySet<string>>(new Set());
  const foldsInUse: RecommendationsFolds = folds ?? {
    isOpen: (key) => localFolds.has(key),
    toggle: (key) =>
      setLocalFolds((current) => {
        const next = new Set(current);
        if (!next.delete(key)) {
          next.add(key);
        }
        return next;
      }),
  };
  const selected = applied ?? picked;
  const locked = applied !== null || sending || onApply === undefined;
  const pending =
    applied !== null && applied.some((id) => outcomes[id] === undefined);
  const kept =
    applied === null
      ? null
      : applied.filter((id) => {
          const status = outcomes[id]?.status;
          return status !== 'failed' && status !== 'skipped';
        });
  const projectedIds = kept ?? (picked.length === 0 ? null : picked);
  const projected =
    projectedIds === null
      ? items
      : items.filter((item) => projectedIds.includes(item.id));
  const minutesSaved = projected.reduce(
    (sum, item) => sum + item.minutesSaved,
    0,
  );
  const priced = projected.filter((item) => item.costSavedUsd !== null);
  const costSavedUsd =
    priced.length === 0
      ? null
      : priced.reduce((sum, item) => sum + (item.costSavedUsd ?? 0), 0);
  const groups = (
    [
      ['workflow', 'Workflow'],
      ['repo', 'Repository'],
      ['user', 'Your agent instructions'],
      ['memory', 'Memory'],
    ] as const
  )
    .filter(([target]) => target !== 'workflow' || workflow)
    .map(([target, label]) => ({
      label,
      items: items.filter((item) => item.target === target),
    }))
    .filter((group) => group.items.length > 0);
  const unit: ProjectionUnit = workflow ? 'run' : 'thread';
  const hotNodes = new Set(
    hotspots.flatMap((hotspot) =>
      hotspot.node === null ? [] : [hotspot.node],
    ),
  );

  const toggle = (id: string): void =>
    setPicked(
      picked.includes(id)
        ? picked.filter((value) => value !== id)
        : [...picked, id],
    );

  return (
    <div
      data-slot="recommendations-card"
      data-state={
        applied === null ? 'selecting' : pending ? 'applying' : 'applied'
      }
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="m-0 flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden />
          {workflowStats !== null
            ? `Workflow analysis · ${workflowStats.runs} run${workflowStats.runs === 1 ? '' : 's'}`
            : hotspots.length > 0
              ? workflow
                ? 'Workflow analysis'
                : 'Thread analysis'
              : 'Recommendations'}
        </p>
        {summary === null ? null : (
          <p className="m-0 text-xs leading-relaxed text-muted-foreground">
            {summary}
          </p>
        )}
      </div>
      {timing === null ? null : <TimingStrip timing={timing} look={look} />}
      {workflowStats === null ? null : (
        <WorkflowFigures
          stats={workflowStats}
          look={look}
          folds={foldsInUse}
          hotNodes={hotNodes}
        />
      )}
      {hotspots.length === 0 ? null : (
        <Hotspots
          hotspots={hotspots}
          stats={workflowStats}
          items={items}
          selected={selected}
          locked={locked}
          look={look}
          onToggle={toggle}
        />
      )}
      {items.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">
          {hotspots.length === 0
            ? 'No recommendations — nothing was found worth changing.'
            : 'No recommendations on this card.'}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          {workflowStats === null && hotspots.length === 0 ? null : (
            <SectionTitle>Recommendations</SectionTitle>
          )}
          {groups.map((group) => (
            <section
              key={group.label}
              className="flex min-w-0 flex-col gap-0.5">
              <h4 className="m-0 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {group.label}
              </h4>
              <ul className="m-0 flex list-none flex-col p-0">
                {group.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    selected={selected.includes(item.id)}
                    locked={locked}
                    outcome={outcomes[item.id] ?? null}
                    queued={applied?.includes(item.id) === true}
                    folds={foldsInUse}
                    look={look}
                    unit={unit}
                    onToggle={() => toggle(item.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {items.length === 0 ? null : (
        <RecommendationsProjection
          baseline={{
            wallMs: workflowStats?.perRun.wallMs ?? timing?.wallMs ?? null,
            costUsd: workflowStats?.perRun.costUsd ?? null,
          }}
          minutesSaved={minutesSaved}
          costSavedUsd={costSavedUsd}
          scope={projectionScope(kept, picked, items.length)}
          unit={unit}
          look={look}
        />
      )}
      {error === null ? null : (
        <ErrorBanner
          message={error}
          onDismiss={onDismissError ?? (() => undefined)}
        />
      )}
      {items.length === 0 ||
      applied !== null ||
      onApply === undefined ? null : (
        <div
          data-slot="recommendations-footer"
          className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <span className="mr-auto text-xs text-muted-foreground">
            {selected.length} of {items.length} selected
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={sending}
            onClick={() => setPicked(items.map((item) => item.id))}>
            Select all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={sending || selected.length === 0}
            onClick={() => setPicked([])}>
            Clear
          </Button>
          <Button
            type="button"
            size="sm"
            className="max-[420px]:w-full"
            disabled={sending || selected.length === 0}
            onClick={() => onApply([...selected])}>
            {sending ? 'Applying…' : 'Apply selected'}
          </Button>
        </div>
      )}
    </div>
  );
}
