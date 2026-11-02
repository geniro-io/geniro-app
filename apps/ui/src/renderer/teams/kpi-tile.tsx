/**
 * A tiny trend line under a figure — the figure beside it carries the number,
 * so the line is hidden from assistive tech. A null value is a gap: the line
 * breaks there instead of dipping to zero, and a lone reading is a dot.
 */
function Sparkline({
  values,
  color,
}: {
  values: readonly (number | null)[];
  color: string;
}): React.JSX.Element | null {
  const measured = values.filter((value): value is number => value !== null);
  if (values.length < 2 || measured.length === 0) {
    return null;
  }
  const width = 96;
  const height = 24;
  const max = Math.max(...measured);
  const min = Math.min(...measured);
  const span = max - min || 1;
  const segments: { x: number; y: number }[][] = [];
  let open = false;
  values.forEach((value, index) => {
    if (value === null) {
      open = false;
      return;
    }
    const point = {
      x: (index / (values.length - 1)) * width,
      y: height - 2 - ((value - min) / span) * (height - 4),
    };
    if (open) {
      segments[segments.length - 1]?.push(point);
    } else {
      segments.push([point]);
      open = true;
    }
  });
  return (
    <svg
      aria-hidden="true"
      data-slot="kpi-sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible">
      {segments.map((segment, index) =>
        segment.length === 1 ? (
          <circle
            key={index}
            cx={segment[0]?.x.toFixed(1)}
            cy={segment[0]?.y.toFixed(1)}
            r={1.5}
            fill={color}
          />
        ) : (
          <polyline
            key={index}
            points={segment
              .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
              .join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ),
      )}
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
  note = null,
  color = 'var(--color-chart-1)',
}: {
  caption: string;
  value: string | null;
  /** One reading per step; null is a step nothing measured, drawn as a gap. */
  trend?: readonly (number | null)[] | null;
  /** A short line under the trend, for what the figure includes. */
  note?: string | null;
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
      {note === null ? null : (
        <span className="text-xs text-muted-foreground">{note}</span>
      )}
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
