import { PROFILE_COLORS } from '../../shared/contracts';
import { PALETTE_DOT_CLASS } from './ui/palette';
import { cn } from './ui/utils';

const KIB = 1024;

/** A process using at least this much of one core is drawn as busy. */
export const BUSY_CPU_PERCENT = 50;

/** Resident memory in the unit a reader expects from Activity Monitor. */
export function formatMemory(bytes: number): string {
  if (bytes < KIB * KIB) {
    return `${Math.max(0, Math.round(bytes / KIB))} KB`;
  }
  if (bytes < KIB * KIB * KIB) {
    return `${(bytes / (KIB * KIB)).toFixed(1)} MB`;
  }
  return `${(bytes / (KIB * KIB * KIB)).toFixed(2)} GB`;
}

/** Percent of one core, as `ps` and Activity Monitor both state it. */
export function formatCpu(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

/**
 * The two figure columns every process readout ends a row with — CPU then
 * memory, at fixed widths so a header, a total and every row line up in one
 * column whoever draws them. An idle process's CPU recedes, a busy one's is
 * the warning tone: in a list of thirty `0.0%`s the one that is working is
 * what a reader is looking for.
 */
export function ProcessFigureCells({
  cpuPercent,
  rssBytes,
  strong = false,
}: {
  cpuPercent: number;
  rssBytes: number;
  /** A total rather than one process — drawn at full weight. */
  strong?: boolean;
}): React.JSX.Element {
  return (
    <>
      <span
        data-slot="process-cpu"
        className={cn(
          'w-12 shrink-0 text-right tabular-nums',
          cpuPercent >= BUSY_CPU_PERCENT
            ? 'font-medium text-warning'
            : cpuPercent < 0.1
              ? 'text-muted-foreground'
              : 'text-foreground',
        )}>
        {formatCpu(cpuPercent)}
      </span>
      <span
        data-slot="process-memory"
        className={cn(
          'w-16 shrink-0 text-right tabular-nums text-foreground',
          strong && 'font-medium',
        )}>
        {formatMemory(rssBytes)}
      </span>
    </>
  );
}

/** The caption over those two columns. */
export function ProcessFigureHeader({
  label,
  className,
  columns = true,
}: {
  label: React.ReactNode;
  /** For a caller whose rows are inset, so the columns still line up. */
  className?: string;
  /** False for a caption under one that already named the columns. */
  columns?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-baseline gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase',
        className,
      )}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {columns ? (
        <>
          <span className="w-12 shrink-0 text-right">cpu</span>
          <span className="w-16 shrink-0 text-right">memory</span>
        </>
      ) : null}
    </div>
  );
}

/** One part of a whole, as a {@link ShareStack} draws it. */
export interface ShareSegment {
  key: string;
  label: string;
  value: number;
  /** A token-backed background class — {@link segmentColorClass}, usually. */
  colorClass: string;
}

/**
 * The colour a part is drawn in, by its position in the list: the app's ONE
 * named palette, so a thread's dot and its stretch of the bar are the same
 * colour by construction rather than by two lookups agreeing.
 */
export function segmentColorClass(index: number): string {
  const color = PROFILE_COLORS[index % PROFILE_COLORS.length] ?? 'blue';
  return PALETTE_DOT_CLASS[color];
}

/** The colour of what is not a part in its own right — geniro, "the rest". */
export const NEUTRAL_SEGMENT_CLASS = 'bg-muted-foreground/40';

/** A share in words: whole percent, and never a `0%` for something present. */
export function formatShare(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return '0%';
  }
  return fraction < 0.01 ? '<1%' : `${Math.round(fraction * 100)}%`;
}

/**
 * ONE bar divided into its parts — how the app's memory splits across its
 * threads, how a thread's splits across its agent, its servers and its
 * commands. A division rather than a row of separate bars, because the
 * question is "who has the most of THIS total", which a reader answers from
 * relative lengths side by side and cannot answer from bars stacked under
 * different rows.
 */
export function ShareStack({
  segments,
  label,
}: {
  segments: readonly ShareSegment[];
  /** What is being divided — read with each part's share. */
  label: string;
}): React.JSX.Element {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div
      role="img"
      aria-label={`${label}: ${segments
        .map(
          (segment) =>
            `${segment.label} ${formatShare(total > 0 ? segment.value / total : 0)}`,
        )
        .join(', ')}`}
      data-slot="share-stack"
      className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted">
      {total > 0
        ? segments
            .filter((segment) => segment.value > 0)
            .map((segment) => (
              <div
                key={segment.key}
                data-slot="share-segment"
                title={`${segment.label} · ${formatShare(segment.value / total)}`}
                className={cn('h-full min-w-[3px]', segment.colorClass)}
                // A width is geometry, not colour — the one inline style here.
                style={{ width: `${(segment.value / total) * 100}%` }}
              />
            ))
        : null}
    </div>
  );
}

/** The dot that ties a row to its stretch of a {@link ShareStack}. */
export function ShareDot({
  colorClass,
}: {
  colorClass: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-slot="share-dot"
      className={cn('size-2 shrink-0 rounded-full', colorClass)}
    />
  );
}
