import { cva } from 'class-variance-authority';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { useState } from 'react';

import {
  AssessmentVerdict,
  type AssessmentVerdictValue,
} from './assessment-verdict';
import { ErrorBanner } from './error-banner';
import { MemberMarks, type MemberVerdict } from './member-marks';
import {
  deltaTone,
  Disclosure,
  type ProjectionUnit,
  type RecommendationsFolds,
  type RecommendationsLook,
  RecommendationsProjection,
  SectionTitle,
  type TeamAgentStatsView,
  TeamFigures,
  type TeamStatsView,
  workedShare,
} from './recommendations-figures';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { OptionIndicator } from './ui/option-list';

export type {
  RecommendationsFolds,
  RecommendationsLook,
  TeamStatsView,
} from './recommendations-figures';

export type RecommendationRisk = 'low' | 'medium' | 'high';
export type RecommendationTerritory = 'process' | 'domain';
export type RecommendationOutcomeStatus = 'applied' | 'skipped' | 'failed';

/** One recommendation as the card draws it. */
export interface RecommendationView {
  id: string;
  target:
    | 'team'
    | 'repo'
    | 'user'
    | 'memory'
    | 'project'
    | 'overlay'
    | 'knowledge'
    | 'external';
  territory: RecommendationTerritory;
  kind: string;
  location: string;
  title: string;
  change: string;
  evidence: {
    /** The run the quote is from — a team analysis reads several. */
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
  /** A knowledge item: the document it acts on. */
  document?: { place: string; handle: string | null; title: string | null };
  /** A knowledge item: the item holding the other side of a move. */
  movesWith?: string | null;
}

/** The other side of a move `id` is one side of, or null: the two are ticked together. */
export function movePartnerOf(
  items: readonly RecommendationView[],
  id: string,
): string | null {
  const own = items.find((item) => item.id === id)?.movesWith;
  return own ?? items.find((item) => item.movesWith === id)?.id ?? null;
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

/** One member as the analysis judged it — its marks, verdict and the items that carry the verdict out. */
export interface MemberAssessmentView {
  member: string;
  /** Null when the analysis found too little to judge. */
  usefulness: number | null;
  quality: number | null;
  verdict: MemberVerdict;
  summary: string;
  evidence: RecommendationView['evidence'];
  items: string[];
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

function EvidenceList({
  evidence,
}: {
  evidence: RecommendationView['evidence'];
}): React.JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {evidence.map((entry, index) => (
        <li key={`${entry.seq}:${index}`} className="min-w-0">
          <span className="font-mono text-[11px] text-muted-foreground">
            {[
              entry.runId == null ? null : `run ${entry.runId.slice(0, 8)}`,
              `seq ${entry.seq}`,
              entry.nodeId,
              entry.ts,
            ]
              .filter((part): part is string => part !== null)
              .join(' · ')}
          </span>
          <blockquote className="m-0 border-l-2 border-border pl-2 break-words text-muted-foreground">
            {entry.quote}
          </blockquote>
        </li>
      ))}
    </ul>
  );
}

/** The card's items named by `ids`, each a toggle that ticks it on the card. */
function ItemToggles({
  label,
  ids,
  items,
  selected,
  locked,
  slot,
  onToggle,
}: {
  label: string;
  ids: readonly string[];
  items: readonly RecommendationView[];
  selected: readonly string[];
  locked: boolean;
  slot: string;
  onToggle: (id: string) => void;
}): React.JSX.Element | null {
  const named = ids.flatMap((id) => {
    const item = items.find((each) => each.id === id);
    return item === undefined ? [] : [item];
  });
  if (named.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {named.map((item) => {
        const on = selected.includes(item.id);
        return (
          <button
            key={item.id}
            type="button"
            data-slot={slot}
            aria-pressed={on}
            disabled={locked}
            title={item.title}
            onClick={() => onToggle(item.id)}
            className={fixToggle({ on })}>
            {on ? <Check aria-hidden="true" className="size-3" /> : null}
            {item.id}
          </button>
        );
      })}
    </div>
  );
}

function ItemRow({
  item,
  moveWith,
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
  /** The other side of the move this item is one side of. */
  moveWith: string | null;
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
              {moveWith === null ? null : (
                <Badge
                  variant="muted"
                  title="One move: the two are selected and applied together"
                  data-slot="recommendation-move">
                  moves with {moveWith}
                </Badge>
              )}
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
            <EvidenceList evidence={item.evidence} />
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
            {item.document === undefined
              ? item.location
              : `${item.document.place} · ${item.document.handle ?? item.document.title ?? item.location}`}
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
  named = true,
}: {
  agent: TeamAgentStatsView;
  stats: TeamStatsView;
  look: RecommendationsLook;
  /** Lead with the agent's name; off where the row already names it. */
  named?: boolean;
}): React.JSX.Element {
  const share = workedShare(stats, agent);
  return (
    <p
      data-slot="analysis-hotspot-figures"
      className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
      {named ? (
        <span className="font-medium text-foreground">{agent.node}</span>
      ) : null}
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
  stats: TeamStatsView | null;
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
                <ItemToggles
                  label="Fixed by"
                  ids={hotspot.items}
                  items={items}
                  selected={selected}
                  locked={locked}
                  slot="analysis-hotspot-fix"
                  onToggle={onToggle}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The user's verdicts on a card's member assessments, and how to set one. */
export interface MemberVerdictControl {
  verdicts: Readonly<Record<string, AssessmentVerdictValue | null>>;
  onChange: (
    member: string,
    next: AssessmentVerdictValue | null,
  ) => Promise<void>;
}

function MemberAssessments({
  members,
  stats,
  items,
  selected,
  locked,
  look,
  folds,
  verdicts,
  onToggle,
}: {
  members: readonly MemberAssessmentView[];
  stats: TeamStatsView | null;
  items: readonly RecommendationView[];
  selected: readonly string[];
  locked: boolean;
  look: RecommendationsLook;
  folds: RecommendationsFolds;
  verdicts: MemberVerdictControl | null;
  onToggle: (id: string) => void;
}): React.JSX.Element {
  const assessed = new Set(members.map((member) => member.member));
  const unassessed = (stats?.agents ?? [])
    .map((agent) => agent.node)
    .filter((node) => !assessed.has(node));
  return (
    <section
      data-slot="analysis-members"
      className="flex min-w-0 flex-col gap-2">
      <SectionTitle>How each member did</SectionTitle>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {members.map((member) => {
          const agent =
            stats?.agents.find((each) => each.node === member.member) ?? null;
          const fold = `member:${member.member}`;
          return (
            <li
              key={member.member}
              data-slot="analysis-member"
              data-member={member.member}
              className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium break-words">
                  {member.member}
                </span>
                <MemberMarks
                  usefulness={member.usefulness}
                  quality={member.quality}
                  verdict={member.verdict}
                />
              </div>
              {agent === null || stats === null ? null : (
                <HotspotFigures
                  agent={agent}
                  stats={stats}
                  look={look}
                  named={false}
                />
              )}
              <p className="m-0 text-xs leading-relaxed break-words text-muted-foreground">
                {member.summary}
              </p>
              <ItemToggles
                label="Carried out by"
                ids={member.items}
                items={items}
                selected={selected}
                locked={locked}
                slot="analysis-member-fix"
                onToggle={onToggle}
              />
              <Disclosure
                label="Evidence"
                open={folds.isOpen(fold)}
                onToggle={() => folds.toggle(fold)}>
                <div className="text-xs leading-relaxed">
                  <EvidenceList evidence={member.evidence} />
                </div>
              </Disclosure>
              {verdicts === null ? null : (
                <AssessmentVerdict
                  value={verdicts.verdicts[member.member] ?? null}
                  onChange={(next) => verdicts.onChange(member.member, next)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {unassessed.length === 0 ? null : (
        <p
          data-slot="analysis-members-unassessed"
          className="m-0 text-[11px] text-muted-foreground">
          Not assessed: {unassessed.join(', ')}
        </p>
      )}
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
  teamStats = null,
  hotspots = [],
  members = [],
  memberVerdicts = null,
  team,
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
  teamStats?: TeamStatsView | null;
  hotspots?: readonly RecommendationHotspotView[];
  /** Each member as the analysis judged it; a plain chat has none. */
  members?: readonly MemberAssessmentView[];
  /** The user's verdicts on those marks; absent draws no verdict control. */
  memberVerdicts?: MemberVerdictControl | null;
  /** The analysed thread is a team; a plain chat gets no Team group. */
  team: boolean;
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
      ['team', 'Team'],
      ['repo', 'Repository'],
      ['user', 'Your agent instructions'],
      ['memory', 'Memory'],
      ['project', 'Project instructions'],
      ['overlay', 'Project overlay'],
      ['knowledge', 'Knowledge'],
      ['external', 'Other repositories'],
    ] as const
  )
    .filter(([target]) => target !== 'team' || team)
    .map(([target, label]) => ({
      label,
      items: items.filter((item) => item.target === target),
    }))
    .filter((group) => group.items.length > 0);
  const unit: ProjectionUnit = team ? 'run' : 'thread';
  const projectionPopulation =
    teamStats?.population == null
      ? null
      : {
          runs: teamStats.population.runs,
          sampleRuns: teamStats.runs,
          costPerRunUsd: teamStats.population.perRun.costUsd,
        };
  const hotNodes = new Set(
    hotspots.flatMap((hotspot) =>
      hotspot.node === null ? [] : [hotspot.node],
    ),
  );

  const toggle = (id: string): void => {
    const partner = movePartnerOf(items, id);
    const both = partner === null ? [id] : [id, partner];
    setPicked(
      picked.includes(id)
        ? picked.filter((value) => !both.includes(value))
        : [...new Set([...picked, ...both])],
    );
  };

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
          {teamStats !== null
            ? `Team analysis · ${teamStats.runs} run${teamStats.runs === 1 ? '' : 's'}`
            : hotspots.length > 0
              ? team
                ? 'Team analysis'
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
      {teamStats === null ? null : (
        <TeamFigures
          stats={teamStats}
          look={look}
          folds={foldsInUse}
          hotNodes={hotNodes}
        />
      )}
      {hotspots.length === 0 ? null : (
        <Hotspots
          hotspots={hotspots}
          stats={teamStats}
          items={items}
          selected={selected}
          locked={locked}
          look={look}
          onToggle={toggle}
        />
      )}
      {members.length === 0 ? null : (
        <MemberAssessments
          members={members}
          stats={teamStats}
          items={items}
          selected={selected}
          locked={locked}
          look={look}
          folds={foldsInUse}
          verdicts={memberVerdicts}
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
          {teamStats === null && hotspots.length === 0 ? null : (
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
                    moveWith={movePartnerOf(items, item.id)}
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
            wallMs: teamStats?.perRun.wallMs ?? timing?.wallMs ?? null,
            costUsd: teamStats?.perRun.costUsd ?? null,
          }}
          minutesSaved={minutesSaved}
          costSavedUsd={costSavedUsd}
          scope={projectionScope(kept, picked, items.length)}
          unit={unit}
          population={projectionPopulation}
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
