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
}: {
  label: string;
  /** For a caller whose rows are inset, so the columns still line up. */
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-baseline gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase',
        className,
      )}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="w-12 shrink-0 text-right">cpu</span>
      <span className="w-16 shrink-0 text-right">memory</span>
    </div>
  );
}

/**
 * A thin bar stating one part's share of a whole — how much of a thread's
 * memory one agent holds, how much of the app's one thread holds. A share and
 * not a gauge: there is no limit to fill towards, only a total to divide.
 */
export function ShareBar({
  fraction,
  label,
}: {
  fraction: number;
  /** Read by a screen reader in place of the bar. */
  label: string;
}): React.JSX.Element {
  const clamped = Number.isFinite(fraction)
    ? Math.min(1, Math.max(0, fraction))
    : 0;
  return (
    <div
      role="img"
      aria-label={label}
      data-slot="share-bar"
      className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary/70"
        // A width is geometry, not colour — the one inline style here.
        style={{ width: `${Math.max(clamped * 100, clamped > 0 ? 2 : 0)}%` }}
      />
    </div>
  );
}
