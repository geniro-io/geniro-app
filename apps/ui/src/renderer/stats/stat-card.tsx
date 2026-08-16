import type { LucideIcon } from 'lucide-react';

import { Card, CardContent } from '../components/ui/card';
import { cn } from '../components/ui/utils';
import { NOT_MEASURED, NOT_MEASURED_TITLE } from './stats-format';

/**
 * One measured figure.
 *
 * The icon is not decoration: eight of these sit in a grid, and a reader
 * looking for spend or for time finds the shape before they finish reading the
 * label. It is tinted with the card's own accent so the row reads as one family
 * rather than eight competing colours.
 *
 * A NOT-MEASURED value is styled DOWN — muted, lighter weight — because it is
 * not a figure at all, and giving it the same visual weight as a real one is
 * how "—" starts reading as a number.
 */
export function StatCard({
  label,
  value,
  icon,
  hint,
  footnote,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  hint?: string;
  /** A second line under the figure — a rate, a share, a denominator. */
  footnote?: string;
}): React.JSX.Element {
  // Bound to a local rather than renamed in the destructure: a PascalCase
  // PARAMETER is an eslint error, and JSX needs the capital to read it as a
  // component. Same shape `nav-rail` uses for the same reason.
  const Icon = icon;
  const unmeasured = value === NOT_MEASURED;
  return (
    <Card className="transition-colors hover:border-primary/30">
      <CardContent
        data-slot="stat"
        className="flex items-start gap-3 p-4"
        title={unmeasured ? NOT_MEASURED_TITLE : hint}>
        <span
          aria-hidden="true"
          className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span
            data-slot="stat-label"
            className="text-xs text-muted-foreground">
            {label}
          </span>
          <span
            data-slot="stat-value"
            className={cn(
              'truncate text-xl font-semibold tabular-nums',
              unmeasured && 'font-normal text-muted-foreground',
            )}>
            {value}
          </span>
          {footnote ? (
            <span className="text-xs leading-snug text-muted-foreground">
              {footnote}
            </span>
          ) : null}
        </span>
      </CardContent>
    </Card>
  );
}

/**
 * The one figure the page is really about, given the room to say so.
 *
 * Spend gets its own card at the top rather than a cell in the grid: it is the
 * question people open this page with, and at grid size it sat level with
 * "Tokens in" — which nobody opens this page to learn.
 */
export function HeroStat({
  value,
  caption,
  aside,
}: {
  value: string;
  caption: string;
  /** The supporting figures shown alongside — label/value pairs. */
  aside: readonly { label: string; value: string }[];
}): React.JSX.Element {
  return (
    <Card className="overflow-hidden">
      <CardContent className="flex flex-wrap items-end justify-between gap-6 p-6">
        <div data-slot="stat" className="flex min-w-0 flex-col gap-1">
          <span
            data-slot="stat-label"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {caption}
          </span>
          <span
            data-slot="stat-value"
            className={cn(
              'text-4xl font-semibold tabular-nums',
              value === NOT_MEASURED && 'text-muted-foreground',
            )}
            title={value === NOT_MEASURED ? NOT_MEASURED_TITLE : undefined}>
            {value}
          </span>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          {aside.map((item) => (
            <div
              key={item.label}
              data-slot="stat"
              className="flex flex-col gap-0.5">
              <dt
                data-slot="stat-label"
                className="text-xs text-muted-foreground">
                {item.label}
              </dt>
              <dd
                data-slot="stat-value"
                className={cn(
                  'text-base font-medium tabular-nums',
                  item.value === NOT_MEASURED && 'text-muted-foreground',
                )}>
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
