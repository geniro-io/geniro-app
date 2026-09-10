import {
  CircleDollarSign,
  Coins,
  ListChecks,
  Timer,
  Wrench,
} from 'lucide-react';

import { HoverPopover } from '../components/hover-popover';
import { formatExactUsd, formatTokens } from './agent-activity';
import { formatElapsed } from './live-row';
import { TaskCount } from './task-list';
import type { SubagentBlockEntry } from './transcript-groups';

/**
 * One measured fact, as a glyph and its value.
 *
 * The glyph replaces a WORD, which is the whole of the compaction: `14 tools ·
 * 82.1k tokens · took 7m 55s` is 34 characters of which 16 are labels, and the
 * labels are the part a reader already knows from the shape of the number.
 */
function MetaChip({
  icon,
  children,
  slot,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  slot: string;
}): React.JSX.Element {
  return (
    <span
      data-slot={slot}
      className="flex shrink-0 items-center gap-0.5 tabular-nums">
      {icon}
      {children}
    </span>
  );
}

/** One labelled row of the popover — the long form of a chip. */
function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

/**
 * What a delegate COST and how far it got, as one small block of icon chips
 * with the long form behind a hover.
 *
 * REPORTED as "у нас сейчас сломан UI, видимо, из-за того, что всё не помещается
 * в одну строку" over a header reading
 * `geniro:test-runner-agent · claude-sonnet-5 · 14 tools · 82.1k tokens · took
 * 7m 55s`, which wraps onto a second line and takes the delegate's own name
 * down with it. The ask names the fix exactly: icons instead of the words, one
 * small block instead of a run of separated facts, and the general information
 * in a popover — "модель тоже не нужно писать, только в поповере будет".
 *
 * Three things follow from that, and the first is why this is a component
 * rather than a few spans in the header.
 *
 * **It lives in `headerAction`, beside the disclosure and never inside it.**
 * The header of a collapsible `BlockShell` IS the toggle's `<button>`, so the
 * popover's own trigger button could not be placed among the facts — nesting a
 * control in a button is invalid HTML whatever role it wears, and it swallows
 * presses meant for the toggle. That constraint is also what makes the fix
 * complete rather than cosmetic: moving the figures out of the header run
 * leaves the name the only thing competing for the row's width, which is the
 * reported symptom.
 *
 * **The MODEL is popover-only**, as asked. It is the longest fact on the row
 * (`claude-sonnet-5` is fifteen characters, more than the three figures
 * together once they are glyphed) and the one least often the reason somebody
 * is scanning a column of delegates.
 *
 * **A figure nothing measured is absent, never zero.** Every chip is drawn only
 * when the delegate reported it — cursor reports none of them (measured: 0 of
 * 82 turns carry tokens, cost or duration) — so its block is the tasks chip
 * alone, or nothing at all. A `$0.00` or a `0 tokens` would claim a
 * measurement nobody took, which is the rule the run it replaces already
 * followed.
 */
export function SubagentMetaChips({
  block,
  title,
  toolCount,
  tasks,
}: {
  block: SubagentBlockEntry;
  /** The delegate's own name, so the popover says what it is describing. */
  title: string;
  toolCount: number;
  tasks: { done: number; total: number } | null;
}): React.JSX.Element | null {
  const hasAny =
    toolCount > 0 ||
    block.tokens !== null ||
    block.costUsd !== null ||
    block.durationMs !== null ||
    tasks !== null ||
    block.model !== null;
  if (!hasAny) {
    return null;
  }
  // The accessible name carries the whole reading, so nothing here is reachable
  // only by opening the panel — the rule `HoverPopover`'s own `label` states.
  const spoken = [
    block.model === null ? null : `model ${block.model}`,
    toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : null,
    block.tokens === null ? null : `${formatTokens(block.tokens)} tokens`,
    block.costUsd === null ? null : `about ${formatExactUsd(block.costUsd)}`,
    block.durationMs === null
      ? null
      : `took ${formatElapsed(block.durationMs)}`,
    tasks === null ? null : `${tasks.done} of ${tasks.total} tasks done`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  return (
    <HoverPopover
      slot="subagent-meta"
      label={`${title}: ${spoken}`}
      panelLabel={`What ${title} spent`}
      side="bottom"
      align="end"
      triggerClassName="rounded-md"
      panelClassName="min-w-56"
      trigger={
        /* ONE block, ruled, rather than a run of separated facts: the ask was
           to "объединить в один маленький блок", and a border is what says
           these glyphs are one reading instead of four unrelated marks. */
        <span
          data-slot="subagent-meta-chips"
          className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {toolCount > 0 ? (
            <MetaChip
              slot="subagent-meta-tools"
              icon={<Wrench aria-hidden="true" className="size-3" />}>
              {toolCount}
            </MetaChip>
          ) : null}
          {block.tokens === null ? null : (
            <MetaChip
              slot="subagent-meta-tokens"
              icon={<Coins aria-hidden="true" className="size-3" />}>
              {formatTokens(block.tokens)}
            </MetaChip>
          )}
          {block.costUsd === null ? null : (
            <MetaChip
              slot="subagent-meta-cost"
              icon={<CircleDollarSign aria-hidden="true" className="size-3" />}>
              {/* The `≈` survives the compaction. It is the whole of what marks
                this figure as DERIVED rather than reported, so a glyph that
                dropped it would upgrade an estimate to a measurement. */}
              {`≈${formatExactUsd(block.costUsd)}`}
            </MetaChip>
          )}
          {block.durationMs === null ? null : (
            <MetaChip
              slot="subagent-meta-duration"
              icon={<Timer aria-hidden="true" className="size-3" />}>
              {formatElapsed(block.durationMs)}
            </MetaChip>
          )}
          {tasks === null ? null : (
            <MetaChip
              slot="subagent-meta-tasks"
              icon={<ListChecks aria-hidden="true" className="size-3" />}>
              <TaskCount done={tasks.done} total={tasks.total} />
            </MetaChip>
          )}
        </span>
      }>
      <div
        data-slot="subagent-meta-detail"
        className="flex flex-col gap-1 text-xs">
        {block.model === null ? null : (
          <DetailRow label="Model" value={block.model} />
        )}
        {toolCount > 0 ? <DetailRow label="Tools" value={toolCount} /> : null}
        {block.tokens === null ? null : (
          <DetailRow label="Tokens" value={formatTokens(block.tokens)} />
        )}
        {block.costUsd === null ? null : (
          <DetailRow label="Cost" value={`≈${formatExactUsd(block.costUsd)}`} />
        )}
        {block.durationMs === null ? null : (
          <DetailRow label="Took" value={formatElapsed(block.durationMs)} />
        )}
        {tasks === null ? null : (
          <DetailRow
            label="Tasks"
            value={`${tasks.done} of ${tasks.total} done`}
          />
        )}
      </div>
    </HoverPopover>
  );
}
