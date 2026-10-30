import { ChevronRight, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { ErrorBanner } from './error-banner';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { OptionIndicator } from './ui/option-list';
import { cn } from './ui/utils';

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
  basis: string;
  confidence: number;
  risk: RecommendationRisk;
  riskNote: string;
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
 * How the card spells a duration and colours a sink — the app's own formatter
 * and chart palette, handed in by the screen that draws it, so this shared
 * component depends on no feature screen.
 */
export interface RecommendationsLook {
  formatMs: (ms: number) => string;
  sinkColor: (index: number) => string;
}

/**
 * Where the card's ticked items are kept until Apply — per thread, by the
 * caller, so a row redrawn before Apply keeps them; absent keeps them for
 * the card's own life.
 */
export interface RecommendationsSelection {
  picked: readonly string[];
  setPicked: (ids: readonly string[]) => void;
}

/**
 * Where the card's Why / Change folds are remembered — per thread, by the
 * caller (`useThreadFlags`); absent keeps them for the card's own life.
 */
export interface RecommendationsFolds {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
}

function minutesLabel(minutes: number): string {
  return `≈ ${Math.round(minutes)} min/run`;
}

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

function Disclosure({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
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

function ItemRow({
  item,
  selected,
  locked,
  outcome,
  queued,
  folds,
  onToggle,
}: {
  item: RecommendationView;
  selected: boolean;
  locked: boolean;
  outcome: RecommendationOutcomeView | null;
  queued: boolean;
  folds: RecommendationsFolds;
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
              <Badge variant="secondary">
                {minutesLabel(item.minutesSaved)} · confidence {item.confidence}
                /5
              </Badge>
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

/**
 * An analysis's recommendations: where the analysed thread's time went, and
 * the changes it suggests, each one ticked or left and then applied together.
 *
 * Three states, read from the props rather than held here: selecting (no Apply
 * sent yet), applying (an Apply was sent and some of its items have no outcome
 * yet), applied (every selected item has one). Only the first takes a press —
 * an Apply is sent once.
 */
export function RecommendationsCard({
  summary,
  timing,
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
  const savings = items
    .filter((item) => selected.includes(item.id))
    .reduce((sum, item) => sum + item.minutesSaved, 0);
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
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3">
      <p className="m-0 flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden />
        Recommendations
      </p>
      {timing === null ? null : <TimingStrip timing={timing} look={look} />}
      {summary === null ? null : (
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">
          {summary}
        </p>
      )}
      {items.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">
          No recommendations — nothing was found worth changing.
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.label} className="flex min-w-0 flex-col gap-0.5">
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
                  onToggle={() => toggle(item.id)}
                />
              ))}
            </ul>
          </section>
        ))
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
            {selected.length === 0 ? '' : ` · ${minutesLabel(savings)} saved`}
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
