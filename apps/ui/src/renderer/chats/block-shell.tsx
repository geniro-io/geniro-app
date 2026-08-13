import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { MarkdownContent } from './markdown-content';
import { RunStatusIcon, type RunStatusKind } from './run-status';

/** Block lifecycle in geniro web's vocabulary (see {@link StatusBadge}). */
export type BlockStatus = 'running' | 'done' | 'error' | 'stopped';

const STATUS_BADGE_CLASS: Record<BlockStatus, string> = {
  running: 'bg-primary/10 text-primary',
  done: 'bg-success/15 text-success',
  error: 'bg-destructive/10 text-destructive',
  stopped: 'bg-muted text-muted-foreground',
};

/**
 * The block vocabulary said in the RUN vocabulary's words.
 *
 * The two exist because they answer different questions — a block is a piece of
 * nested work, a run is a conversation — but they share every glyph, so the
 * translation lives here once rather than as a second icon table that drifts
 * from `RUN_STATUS_META`. `stopped → cancelled` is the same reading
 * `subagentThreadsByAgent` makes: work that ended without finishing.
 */
const RUN_STATUS_OF: Record<BlockStatus, RunStatusKind> = {
  running: 'running',
  done: 'completed',
  error: 'failed',
  stopped: 'cancelled',
};

/**
 * The status GLYPH for anything drawn in the block vocabulary — a block header,
 * a tool row inside one.
 *
 * Delegates to {@link RunStatusIcon} so a completed tool call and a completed
 * run wear the same check in the same tone: one icon set for the whole app is
 * the point, and it is why this is a translation rather than a mapping of its
 * own.
 */
export function BlockStatusIcon({
  status,
  className,
}: {
  status: BlockStatus;
  className?: string;
}): React.JSX.Element {
  return <RunStatusIcon status={RUN_STATUS_OF[status]} className={className} />;
}

export function StatusBadge({
  status,
}: {
  status: BlockStatus;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-medium',
        STATUS_BADGE_CLASS[status],
      )}>
      {status}
    </span>
  );
}

/** Geniro web's SectionLabel. */
export function SectionLabel({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className="m-0 mb-1 text-[10px] tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  );
}

/**
 * Geniro web's InlineText: an accent-tinted text panel clamped to a few
 * lines with a bottom fade and a Show more / Show less toggle.
 */
export function InlineClampText({
  text,
  accentClass,
  lines = 3,
}: {
  text: string;
  accentClass: string;
  lines?: number;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.split('\n').length > lines || text.length > lines * 80;
  return (
    <div
      className={cn(
        'rounded-lg px-3 py-2.5 text-[11px] leading-relaxed',
        accentClass,
      )}>
      <div
        className={cn(!expanded && isLong && 'overflow-hidden')}
        style={
          !expanded && isLong
            ? {
                maxHeight: `${lines * 1.8}em`,
                maskImage: 'linear-gradient(to bottom, black 40%, transparent)',
                WebkitMaskImage:
                  'linear-gradient(to bottom, black 40%, transparent)',
              }
            : undefined
        }>
        <MarkdownContent content={text} className="text-[11px]" />
      </div>
      {isLong ? (
        <button
          type="button"
          className="mt-1.5 flex items-center gap-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}>
          {expanded ? (
            <>
              <ChevronUp aria-hidden="true" className="size-3" /> Show less
            </>
          ) : (
            <>
              <ChevronDown aria-hidden="true" className="size-3" /> Show more
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The block's REQUEST panel — what the nested work was asked to do.
 *
 * Shared rather than repeated: the accent classes are the only thing that
 * makes a request panel look like a request panel, and two copies of them is
 * how the two blocks come to disagree after one retint.
 *
 * Tinted with `secondary` (the warm apricot) rather than `primary`, because
 * `primary/5` was 5% of a brown that is itself close to the cream background:
 * the panel came out the same beige as the card holding it, and "what this was
 * asked to do" read as one more paragraph of the surrounding block. It is the
 * FIRST thing in every enclosure, so it is the one panel that has to be
 * separable at a glance — and it now differs from both the neutral card and the
 * green `BlockResult` below it, which is the pairing that carries the meaning.
 */
export function BlockRequest({
  label,
  text,
}: {
  label: React.ReactNode;
  text: string;
}): React.JSX.Element {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <InlineClampText
        text={text}
        accentClass="bg-secondary/20 border border-secondary/50 text-foreground"
      />
    </div>
  );
}

/** The block's RESULT panel — what the nested work came back with. */
export function BlockResult({
  label,
  text,
}: {
  label: React.ReactNode;
  text: string;
}): React.JSX.Element {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <InlineClampText
        text={text}
        accentClass="bg-success/5 border border-success/40 text-foreground"
      />
    </div>
  );
}

/** The block's footer: how much tool work happened inside, and any caveat. */
export function BlockToolFooter({
  count,
  note,
}: {
  count: number;
  note?: React.ReactNode;
}): React.JSX.Element | null {
  if (count === 0) {
    return null;
  }
  return (
    <div className="flex items-center gap-3 pt-0.5 text-[10px] text-muted-foreground">
      <span>
        {count} tool{count === 1 ? '' : 's'}
      </span>
      {note}
    </div>
  );
}

/** The block header's name line — the one identity both card kinds show. */
export function BlockTitle({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

/** The block's live line — what it is doing, while it is still doing it. */
export function BlockPendingLine({
  children,
  pulse = true,
}: {
  children: React.ReactNode;
  pulse?: boolean;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'text-[11px] text-muted-foreground italic',
        pulse && 'animate-pulse',
      )}>
      {children}
    </span>
  );
}

/**
 * The nested-work card both agent-call blocks and sub-agent blocks are drawn
 * on: an eyebrow line naming the KIND of aside, then a bordered card whose
 * header carries the block's own identity, a live spinner and a status chip,
 * over a body holding that block's thread.
 *
 * Extracted rather than copied. `CallBlock` owned this chrome privately, and
 * the sub-agent block needs the same card one collapse-state away — two
 * near-identical cards is exactly the duplication
 * `.claude/rules/renderer-components.md` forbids, and the drift it produces
 * (one card's status chip moving, the other's not) is invisible until someone
 * puts them side by side.
 *
 * **`collapsible` is what separates the two callers, and it is not styling.**
 * A call block is the point of the row it sits on and always renders open; a
 * sub-agent block is an aside the reader opens deliberately, so it starts
 * closed. One prop, not two: no caller wants collapsible-and-already-open, and
 * a separate `defaultOpen` only created a combination nothing produced except
 * the test written for it.
 *
 * `headerAction` renders BESIDE the disclosure button, never inside it.
 * Interactive content nested in a `<button>` is invalid HTML whatever role it
 * carries, and a control there also swallows presses meant for the toggle.
 */
export function BlockShell({
  eyebrow,
  eyebrowIcon,
  header,
  status,
  collapsible = false,
  toggleLabel,
  headerAction,
  children,
}: {
  /** The kind of aside this is — "Agent communication", "Sub-agent". */
  eyebrow: string;
  eyebrowIcon: React.ReactNode;
  /** Identity line inside the card header (avatars, names). */
  header: React.ReactNode;
  status: BlockStatus;
  /** A control sitting beside the header — outside the disclosure button. */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
} & (
  | {
      /** Render the header as a disclosure over the body, closed to start. */
      collapsible: true;
      /**
       * Accessible name for the disclosure button. Required by the TYPE, not
       * by prose: a collapsible shell whose caller forgot it ships a `<button>`
       * with no accessible name at all, since the header content is a truncated
       * `<span>` and an icon.
       */
      toggleLabel: string;
    }
  | { collapsible?: false; toggleLabel?: never }
)): React.JSX.Element {
  const [open, setOpen] = useState(!collapsible);
  const headerInner = (
    <>
      {collapsible ? (
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            !open && '-rotate-90',
          )}
        />
      ) : null}
      {header}
      {status === 'running' ? <Spinner className="size-3.5" /> : null}
      <StatusBadge status={status} />
    </>
  );
  const headerClass =
    'flex min-w-0 flex-1 items-center gap-2 px-4 py-2.5 text-left';
  return (
    <div data-role="block-shell" className="w-full">
      <div className="mb-1.5 ml-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        {eyebrowIcon}
        <span>{eyebrow}</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div
          className={cn(
            'flex items-center bg-muted/30',
            open && 'border-b border-border',
          )}>
          {collapsible ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={toggleLabel}
              onClick={() => setOpen((v) => !v)}
              className={cn(
                headerClass,
                'transition-colors hover:bg-accent/50',
              )}>
              {headerInner}
            </button>
          ) : (
            <div className={headerClass}>{headerInner}</div>
          )}
          {headerAction ? (
            <span className="flex shrink-0 items-center pr-2">
              {headerAction}
            </span>
          ) : null}
        </div>
        {open ? (
          <div className="flex flex-col gap-2.5 p-3">{children}</div>
        ) : null}
      </div>
    </div>
  );
}
