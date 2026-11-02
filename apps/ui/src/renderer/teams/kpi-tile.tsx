/**
 * A tiny trend line under a figure — the figure beside it carries the number,
 * so the line is hidden from assistive tech.
 */
function Sparkline({
  values,
  color,
}: {
  values: readonly number[];
  color: string;
}): React.JSX.Element | null {
  if (values.length < 2) {
    return null;
  }
  const width = 96;
  const height = 24;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - 2 - ((value - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      aria-hidden="true"
      data-slot="kpi-sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * One figure of the team's statistics: an uppercase caption, the number in
 * large tabular type, and its trend. A figure nothing measured is a dash.
 */
export function KpiTile({
  caption,
  value,
  trend = null,
  color = 'var(--color-chart-1)',
}: {
  caption: string;
  value: string | null;
  trend?: readonly number[] | null;
  /** A series colour from `stats/charts/chart-theme.tsx`. */
  color?: string;
}): React.JSX.Element {
  return (
    <div data-slot="kpi-tile" className="flex min-w-0 flex-col gap-1.5 p-5">
      <span className="text-xs font-medium tracking-[0.02em] text-muted-foreground uppercase">
        {caption}
      </span>
      <span className="text-kpi font-semibold tabular-nums">
        {value ?? '—'}
      </span>
      <span className="h-6">
        {trend === null ? null : <Sparkline values={trend} color={color} />}
      </span>
    </div>
  );
}

/** The strip of KPI tiles: one frame around them, no lines between. */
export function KpiStrip({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot="kpi-strip"
      className="grid grid-cols-2 rounded-card bg-card ring-1 ring-border sm:grid-cols-5">
      {children}
    </div>
  );
}
