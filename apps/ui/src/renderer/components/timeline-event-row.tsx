import { cva } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';

import { formatClockTime } from '../chats/relative-time';
import { NavListItem } from './nav-list-item';
import { cn } from './ui/utils';

export type TimelineTone =
  'primary' | 'success' | 'warning' | 'destructive' | 'accent' | 'muted';

const timelineToneVariants = cva(
  'relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-pill ring-4 ring-card',
  {
    variants: {
      tone: {
        primary: 'bg-primary/10 text-primary',
        success: 'bg-success/10 text-success',
        warning: 'bg-warning/10 text-warning',
        destructive: 'bg-destructive/10 text-destructive',
        accent: 'bg-accent text-accent-foreground',
        muted: 'bg-muted text-muted-foreground',
      } satisfies Record<TimelineTone, string>,
    },
  },
);

export interface TimelineEventRowProps {
  icon: LucideIcon;
  tone: TimelineTone;
  sentence: React.ReactNode;
  at: string;
  badge?: React.ReactNode;
  detail?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  live?: boolean;
  onActivate?: () => void;
  activateLabel?: string;
  data?: Record<`data-${string}`, string>;
}

const ROW_CLASS =
  'gap-3 rounded-md px-2 py-1.5 before:absolute before:top-0 before:bottom-0 before:left-5 before:w-px before:bg-border first:before:top-3 last:before:bottom-auto last:before:h-3';

function RowBody({
  icon,
  tone,
  sentence,
  at,
  badge,
  detail,
  meta,
  actions,
  live,
}: Omit<
  TimelineEventRowProps,
  'onActivate' | 'activateLabel' | 'data'
>): React.JSX.Element {
  const Icon = icon;
  return (
    <>
      <span aria-hidden="true" className={timelineToneVariants({ tone })}>
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-6">
            {sentence}
          </p>
          {badge}
          {live ? (
            <span
              aria-hidden="true"
              data-slot="timeline-live-dot"
              className="size-1.5 shrink-0 rounded-pill bg-primary motion-safe:animate-pulse"
            />
          ) : null}
          <time
            dateTime={at}
            title={new Date(at).toLocaleString()}
            className="shrink-0 text-xs leading-6 tabular-nums text-muted-foreground">
            {formatClockTime(at)}
          </time>
        </div>
        {meta === undefined || meta === null ? null : (
          <p
            data-slot="timeline-event-meta"
            className="flex min-w-0 items-baseline gap-1.5 truncate text-xs leading-5 text-muted-foreground">
            {meta}
          </p>
        )}
        {detail === undefined || detail === null ? null : (
          <p className="mt-0.5 line-clamp-2 text-sm leading-5 break-words text-muted-foreground">
            {detail}
          </p>
        )}
        {actions}
      </div>
    </>
  );
}

export function TimelineEventRow({
  onActivate,
  activateLabel,
  data,
  ...body
}: TimelineEventRowProps): React.JSX.Element {
  if (onActivate === undefined) {
    return (
      <li {...data} className={cn('relative flex items-start', ROW_CLASS)}>
        <RowBody {...body} />
      </li>
    );
  }
  return (
    <NavListItem
      active={false}
      activateLabel={activateLabel}
      onActivate={onActivate}
      className={cn('flex-row items-start', ROW_CLASS)}
      contentClassName="flex-1 flex-row items-start gap-3"
      data={data}>
      <RowBody {...body} />
    </NavListItem>
  );
}
