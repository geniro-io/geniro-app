import { cn } from './utils';

/** One wedge of a {@link DonutChart}. */
export interface DonutSlice {
  key: string;
  label: string;
  /** Non-negative; a slice worth nothing is simply not drawn. */
  value: number;
}

/**
 * The wedge palette, in order — the app's eight distinguishable hues.
 *
 * The AVATAR tokens, not `--chart-1..5`. The chart tokens are five shades of
 * one caramel, which is right for a single series and wrong here: wedges have
 * to be told apart from each other, and neighbouring shades of the same hue
 * cannot be. These are the same eight tokens, in the same order, that
 * `chats/chat-metrics.ts` cycles for the context breakdown — its own doc block
 * is where the "a second eight-colour set would drift from them" rule is
 * written, and this list obeys it.
 *
 * `var(--avatar-N)` rather than that module's `bg-avatar-N` classes because an
 * SVG `stroke` is an attribute and takes no class. The two forms are pinned to
 * each other in this component's spec, so neither list can be reordered alone.
 */
const WEDGE_TOKENS = [
  'var(--avatar-1)',
  'var(--avatar-2)',
  'var(--avatar-3)',
  'var(--avatar-4)',
  'var(--avatar-5)',
  'var(--avatar-6)',
  'var(--avatar-7)',
  'var(--avatar-8)',
] as const;

/**
 * A proportional breakdown of one total — which agents, models or projects a
 * period's spend went to.
 *
 * SVG here, unlike the column chart beside it in this directory: arcs need
 * real geometry. Each wedge is one
 * circle with a dash pattern and an offset, so there is no path arithmetic to
 * get wrong at the 100%-of-one-slice boundary, where an arc command flips its
 * large-arc flag and a single-slice donut silently renders as a hairline.
 *
 * Slices beyond the palette fold into one trailing "other" wedge rather than
 * cycling the colours: a repeated colour in a legend reads as the same thing
 * appearing twice.
 */
export function DonutChart({
  slices,
  size = 132,
  thickness = 16,
  ariaLabel,
  className,
}: {
  /**
   * ALREADY NORMALIZED by {@link visibleSlices} — this component renders them
   * in the order given and does not re-fold them.
   *
   * It used to normalize internally, and that silently broke the one thing a
   * legend must do. A caller builds its legend from `visibleSlices(groups)` and
   * keys the swatch colours by index; a second fold in here re-sorted that list,
   * because the trailing "N more" slice can outweigh kept slices, so past eight
   * groups the swatch at index N named a different slice than the wedge at
   * index N. One fold, owned by whoever also builds the legend, is what keeps
   * the two in step.
   */
  slices: readonly DonutSlice[];
  size?: number;
  thickness?: number;
  ariaLabel: string;
  className?: string;
}): React.JSX.Element {
  const drawn = slices;
  const total = drawn.reduce((sum, slice) => sum + slice.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;

  let consumed = 0;
  return (
    <svg
      data-slot="donut-chart"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={ariaLabel}
      className={cn('shrink-0', className)}>
      {/* The track, which is also the whole picture when nothing was measured —
          an empty ring reads as "no data", where an absent chart reads as a
          layout bug. */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border)"
        strokeWidth={thickness}
      />
      {total > 0 &&
        drawn.map((slice, index) => {
          const fraction = slice.value / total;
          const offset = consumed;
          consumed += fraction;
          return (
            <circle
              key={slice.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={wedgeToken(index)}
              strokeWidth={thickness}
              strokeDasharray={`${circumference * fraction} ${circumference}`}
              strokeDashoffset={-circumference * offset}
              // Twelve o'clock, so the largest wedge starts where a reader
              // looks first.
              transform={`rotate(-90 ${size / 2} ${size / 2})`}>
              <title>{slice.label}</title>
            </circle>
          );
        })}
    </svg>
  );
}

/**
 * The wedges actually drawn: positives only, largest first, with everything
 * past the palette folded into one trailing slice.
 *
 * Exported for the legend, which must name exactly what the ring shows — a
 * legend built from the raw list would caption wedges that were folded away.
 */
export function visibleSlices(
  slices: readonly DonutSlice[],
): readonly DonutSlice[] {
  const positive = [...slices]
    .filter((slice) => slice.value > 0)
    .sort((a, b) => b.value - a.value);
  if (positive.length <= WEDGE_TOKENS.length) {
    return positive;
  }
  const kept = positive.slice(0, WEDGE_TOKENS.length - 1);
  const rest = positive.slice(WEDGE_TOKENS.length - 1);
  return [
    ...kept,
    {
      key: '__other__',
      label: `${rest.length} more`,
      value: rest.reduce((sum, slice) => sum + slice.value, 0),
    },
  ];
}

/** The token a wedge at this position is drawn in — for the legend's swatch. */
export function wedgeToken(index: number): string {
  // The modulo cannot land outside the array, but the index signature does not
  // know that — and the muted token is the right thing to be wrong with: a
  // wedge nobody can name reads as unattributed rather than borrowing the
  // colour of the slice above it. Same rule, and the same fallback reasoning,
  // as `contextCategoryColor` in `chats/chat-metrics.ts`.
  return WEDGE_TOKENS[Math.abs(index) % WEDGE_TOKENS.length] ?? 'var(--muted)';
}
