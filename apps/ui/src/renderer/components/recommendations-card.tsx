import { cva } from 'class-variance-authority';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { useState } from 'react';

import type { ProjectRef } from '../projects/use-projects';
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
import { SplitButton } from './split-button';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import type { MenuGroup } from './ui/menu';
import { OptionIndicator } from './ui/option-list';
import { Select } from './ui/select';

export type {
  RecommendationsFolds,
  RecommendationsLook,
  TeamStatsView,
} from './recommendations-figures';

export type RecommendationRisk = 'low' | 'medium' | 'high';
export type RecommendationTerritory = 'process' | 'domain';
export type RecommendationOutcomeStatus = 'applied' | 'skipped' | 'failed';

export const RECOMMENDATION_TARGETS = [
  'team',
  'repo',
  'user',
  'memory',
  'project',
  'overlay',
  'knowledge',
  'external',
  'geniro',
] as const;
export type RecommendationTarget = (typeof RECOMMENDATION_TARGETS)[number];

/** What the card's split button does with the ticked items. */
export const RECOMMENDATION_ACTIONS = ['cards', 'implement', 'report'] as const;
export type RecommendationAction = (typeof RECOMMENDATION_ACTIONS)[number];
type ChosenAction = Exclude<RecommendationAction, 'report'>;

/** One recommendation as the card draws it. */
export interface RecommendationView {
  id: string;
  target: RecommendationTarget;
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
  /** A system analysis: the flag handles this item answers. */
  addressesFlags: readonly string[];
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

/** A clause closed once: it may or may not end its own sentence. */
export function sentence(text: string): string {
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

const SYSTEM_ACTION_LABEL: Record<RecommendationAction, string> = {
  cards: 'Create cards',
  implement: 'Implement right away',
  report: 'Keep as report',
};

const SYSTEM_ACTION_GROUPS: MenuGroup[] = [
  {
    items: RECOMMENDATION_ACTIONS.map((value) => ({
      value,
      label: SYSTEM_ACTION_LABEL[value],
    })),
  },
];

const TICKET_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const TASK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILED_NOTE = /^(?<phrase>filed to start|filed|started) (?<key>\S+)$/;
const START_FAILED_NOTE = /^could not start (?<key>\S+): (?<reason>[\s\S]+)$/;

export interface SystemOutcome {
  /** The ticket key the card was filed as, or the task id when it has none. */
  key: string;
  state: 'filed' | 'start requested' | 'started' | 'start failed';
  /** Why the filed card's start failed; null in every other state. */
  reason: string | null;
}

function isCardKey(key: string): boolean {
  return TICKET_KEY.test(key) || TASK_ID.test(key);
}

/** The board card a system item's outcome says it became, or null for any other outcome. */
export function systemOutcomeOf(
  outcome: Pick<RecommendationOutcomeView, 'status' | 'note'>,
): SystemOutcome | null {
  if (outcome.note === null) {
    return null;
  }
  if (outcome.status === 'failed') {
    const match = START_FAILED_NOTE.exec(outcome.note);
    const key = match?.groups?.key;
    const reason = match?.groups?.reason;
    return key === undefined || reason === undefined || !isCardKey(key)
      ? null
      : { key, state: 'start failed', reason };
  }
  if (outcome.status !== 'applied') {
    return null;
  }
  const match = FILED_NOTE.exec(outcome.note);
  const phrase = match?.groups?.phrase;
  const key = match?.groups?.key;
  if (key === undefined || phrase === undefined || !isCardKey(key)) {
    return null;
  }
  const state =
    phrase === 'filed to start'
      ? 'start requested'
      : phrase === 'started'
        ? 'started'
        : 'filed';
  return { key, state, reason: null };
}

function isRecommendationAction(value: string): value is RecommendationAction {
  return (RECOMMENDATION_ACTIONS as readonly string[]).includes(value);
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
              entry.runId === null || entry.runId === undefined
                ? null
                : `run ${entry.runId.slice(0, 8)}`,
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

const FILED_STATE_BADGE: Record<
  Exclude<SystemOutcome['state'], 'filed'>,
  { variant: 'success' | 'muted' | 'destructive'; label: string }
> = {
  'start requested': { variant: 'muted', label: 'Start requested' },
  started: { variant: 'success', label: 'Started' },
  'start failed': OUTCOME_BADGE.failed,
};

function FiledBadges({ filed }: { filed: SystemOutcome }): React.JSX.Element {
  const state = filed.state === 'filed' ? null : FILED_STATE_BADGE[filed.state];
  return (
    <>
      <Badge variant="outline" data-slot="recommendation-filed">
        {filed.key}
      </Badge>
      {state === null ? null : (
        <Badge variant={state.variant} data-slot="recommendation-outcome">
          {state.label}
        </Badge>
      )}
    </>
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
  const filed = outcome === null ? null : systemOutcomeOf(outcome);
  const result =
    outcome === null || filed !== null ? null : OUTCOME_BADGE[outcome.status];
  const note =
    outcome === null
      ? null
      : filed === null
        ? outcome.note
        : filed.reason === null
          ? null
          : `Could not start: ${filed.reason}`;
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
              {filed !== null ? (
                <FiledBadges filed={filed} />
              ) : result ? (
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
      {outcome !== null && (note !== null || outcome.backup !== null) ? (
        <p className="m-0 pl-6 text-xs text-muted-foreground">
          {[note, outcome.backup === null ? null : `backup: ${outcome.backup}`]
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
            {item.addressesFlags.length === 0 ? null : (
              <p
                data-slot="recommendation-flags"
                className="m-0 text-muted-foreground">
                Answers flags {item.addressesFlags.join(', ')}
              </p>
            )}
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

function MemberAssessments({
  members,
  stats,
  items,
  selected,
  locked,
  look,
  folds,
  onToggle,
}: {
  members: readonly MemberAssessmentView[];
  stats: TeamStatsView | null;
  items: readonly RecommendationView[];
  selected: readonly string[];
  locked: boolean;
  look: RecommendationsLook;
  folds: RecommendationsFolds;
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

function ChooseProjectDialog({
  action,
  projects,
  onConfirm,
  onClose,
}: {
  action: ChosenAction;
  projects: readonly ProjectRef[];
  onConfirm: (projectId: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        action === 'cards'
          ? 'Create cards in which project?'
          : 'Implement right away in which project?'
      }>
      <div className="flex min-w-0 flex-col gap-3">
        {projects.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">
            There is no project to file cards in.
          </p>
        ) : (
          <Select
            aria-label="Project"
            variant="ghost"
            groups={[
              {
                items: projects.map((project) => ({
                  value: project.id,
                  label: project.name,
                  title: project.folder,
                })),
              },
            ]}
            value={projectId}
            placeholder="Choose a project"
            onValueChange={setProjectId}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={projectId === null}
            onClick={() => {
              if (projectId !== null) {
                onConfirm(projectId);
              }
            }}>
            {SYSTEM_ACTION_LABEL[action]}
          </Button>
        </div>
      </div>
    </Dialog>
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
  actions,
  onDismissError,
}: {
  summary: string | null;
  timing: RecommendationsTimingView | null;
  teamStats?: TeamStatsView | null;
  hotspots?: readonly RecommendationHotspotView[];
  /** Each member as the analysis judged it; a plain chat has none. */
  members?: readonly MemberAssessmentView[];
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
  /**
   * A system analysis's card: its button files the ticked items as cards, or
   * starts them, in a project chosen in a dialog; it replaces `onApply`.
   */
  actions?: {
    projects: readonly ProjectRef[];
    onAction: (
      action: RecommendationAction,
      ids: string[],
      projectId: string | null,
    ) => void;
  };
  onDismissError?: () => void;
}): React.JSX.Element {
  const [localPicked, setLocalPicked] = useState<readonly string[]>([]);
  const picked = selection?.picked ?? localPicked;
  const setPicked = selection?.setPicked ?? setLocalPicked;
  const [localFolds, setLocalFolds] = useState<ReadonlySet<string>>(new Set());
  const [systemAction, setSystemAction] =
    useState<RecommendationAction>('cards');
  const [choosing, setChoosing] = useState<ChosenAction | null>(null);
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
  const canAct = actions !== undefined || onApply !== undefined;
  const locked = applied !== null || sending || !canAct;
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
      ['geniro', 'Geniro — code and system instructions'],
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
    teamStats?.population === null || teamStats?.population === undefined
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

  const pressSystemAction = (action: RecommendationAction): void => {
    if (actions === undefined) {
      return;
    }
    if (action === 'report') {
      actions.onAction('report', [], null);
      return;
    }
    setChoosing(action);
  };

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
      {items.length === 0 || applied !== null || !canAct ? null : (
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
          {actions === undefined ? (
            <Button
              type="button"
              size="sm"
              className="max-[420px]:w-full"
              disabled={sending || selected.length === 0}
              onClick={() => onApply?.([...selected])}>
              {sending ? 'Applying…' : 'Apply selected'}
            </Button>
          ) : (
            <SplitButton
              className="max-[420px]:w-full"
              groups={SYSTEM_ACTION_GROUPS}
              value={systemAction}
              menuLabel="Report actions"
              disabled={
                sending || (systemAction !== 'report' && selected.length === 0)
              }
              menuDisabled={sending}
              onClick={() => pressSystemAction(systemAction)}
              onSelect={(value) => {
                if (isRecommendationAction(value)) {
                  setSystemAction(value);
                }
              }}>
              {SYSTEM_ACTION_LABEL[systemAction]}
            </SplitButton>
          )}
        </div>
      )}
      {actions === undefined || choosing === null ? null : (
        <ChooseProjectDialog
          action={choosing}
          projects={actions.projects}
          onClose={() => setChoosing(null)}
          onConfirm={(projectId) => {
            actions.onAction(choosing, [...selected], projectId);
            setChoosing(null);
          }}
        />
      )}
    </div>
  );
}
