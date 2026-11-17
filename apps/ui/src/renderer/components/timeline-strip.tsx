import { cn } from './ui/utils';

export type TimelineSpanKind = 'work' | 'waiting';

export type TimelineMarkerKind =
  | 'user_message'
  | 'question'
  | 'pr_opened'
  | 'pr_merged'
  | 'stage'
  | 'failure'
  | 'manager_out'
  | 'manager_in';

export interface TimelineSpan {
  kind: TimelineSpanKind;
  start: string;
  /** Null while the span is still open: it runs to the strip's end. */
  end: string | null;
}

export interface TimelineMarker {
  kind: TimelineMarkerKind;
  at: string;
  label: string | null;
}

export interface TimelineStripProps {
  start: string;
  end: string;
  spans: TimelineSpan[];
  markers: TimelineMarker[];
  onMarker?: (marker: TimelineMarker) => void;
}

const MARKER_META: Record<
  TimelineMarkerKind,
  { text: string; className: string }
> = {
  user_message: { text: 'Your message', className: 'bg-primary' },
  question: { text: 'Question', className: 'bg-warning' },
  pr_opened: { text: 'PR opened', className: 'bg-group-purple' },
  pr_merged: { text: 'PR merged', className: 'bg-success' },
  stage: { text: 'Stage', className: 'bg-muted-foreground' },
  failure: { text: 'Failure', className: 'bg-destructive' },
  manager_out: { text: 'Sent by manager', className: 'bg-group-teal' },
  manager_in: { text: 'Received by manager', className: 'bg-group-indigo' },
};

const SPAN_CLASS: Record<TimelineSpanKind, string> = {
  work: 'bg-primary/35',
  waiting: 'bg-warning/35 ring-1 ring-inset ring-warning/70',
};

/** The position of `at` along [start, end], clamped to the strip. */
function fractionOf(at: number, start: number, end: number): number {
  const range = end - start;
  if (!(range > 0)) {
    return 0;
  }
  return Math.min(1, Math.max(0, (at - start) / range));
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function markerLabel(marker: TimelineMarker): string {
  const named =
    marker.label === null
      ? MARKER_META[marker.kind].text
      : `${MARKER_META[marker.kind].text}: ${marker.label}`;
  return `${named} (${formatTime(marker.at)})`;
}

const percent = (fraction: number): string => `${fraction * 100}%`;

export function TimelineStrip({
  start,
  end,
  spans,
  markers,
  onMarker,
}: TimelineStripProps): React.JSX.Element {
  const from = Date.parse(start);
  const to = Date.parse(end);
  const hasOpenSpan = spans.some((span) => span.end === null);
  return (
    <div
      data-slot="timeline-strip"
      role="group"
      aria-label="Timeline"
      className="relative h-5 w-full min-w-0 rounded-pill bg-muted/60">
      {spans.map((span, index) => {
        const left = fractionOf(Date.parse(span.start), from, to);
        const right =
          span.end === null ? 1 : fractionOf(Date.parse(span.end), from, to);
        return (
          <span
            key={index}
            data-slot="timeline-span"
            data-kind={span.kind}
            className={cn(
              'absolute inset-y-1 rounded-pill',
              SPAN_CLASS[span.kind],
            )}
            style={{ left: percent(left), width: percent(right - left) }}
          />
        );
      })}
      {markers.map((marker, index) => (
        <button
          key={index}
          type="button"
          data-slot="timeline-marker"
          data-kind={marker.kind}
          aria-label={markerLabel(marker)}
          title={markerLabel(marker)}
          onClick={() => {
            onMarker?.(marker);
          }}
          className={cn(
            'absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
            MARKER_META[marker.kind].className,
          )}
          style={{
            left: percent(fractionOf(Date.parse(marker.at), from, to)),
          }}
        />
      ))}
      <span
        data-slot="timeline-now"
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0 right-0 w-0.5 rounded-pill bg-foreground',
          hasOpenSpan && 'motion-safe:animate-pulse motion-reduce:animate-none',
        )}
      />
    </div>
  );
}
