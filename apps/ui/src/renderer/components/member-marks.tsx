import { cva } from 'class-variance-authority';

import { Badge } from './ui/badge';
import { cn } from './ui/utils';

/** What an analysis advised for one member. Twin of the daemon's `MEMBER_VERDICTS`. */
export type MemberVerdict =
  'keep' | 'tune' | 'reconfigure' | 'replace' | 'remove';

export const MEMBER_VERDICTS: readonly MemberVerdict[] = [
  'keep',
  'tune',
  'reconfigure',
  'replace',
  'remove',
];

const VERDICT_BADGE: Record<
  MemberVerdict,
  {
    label: string;
    hint: string;
    variant: 'success' | 'secondary' | 'warning' | 'destructive';
  }
> = {
  keep: { label: 'Keep', hint: 'It works as it is', variant: 'success' },
  tune: {
    label: 'Tune',
    hint: 'Change its role or instructions',
    variant: 'secondary',
  },
  reconfigure: {
    label: 'Reconfigure',
    hint: 'Change its model, effort or tools',
    variant: 'secondary',
  },
  replace: {
    label: 'Replace',
    hint: 'Put another agent or model in its place, or rewrite its role',
    variant: 'warning',
  },
  remove: {
    label: 'Remove',
    hint: 'The team does not need it: merge its work into another member or drop it',
    variant: 'destructive',
  },
};

const MARK_HINT = {
  usefulness:
    'How much its work moved the runs toward what they set out to do (1–5)',
  quality: 'How its work held up: accepted, or reopened and redone (1–5)',
} as const;

const segment = cva('h-1.5 w-2 rounded-pill', {
  variants: {
    tone: {
      good: 'bg-success',
      fair: 'bg-warning',
      poor: 'bg-destructive',
      empty: 'bg-muted',
    },
  },
});

function toneOf(mark: number): 'good' | 'fair' | 'poor' {
  return mark >= 4 ? 'good' : mark === 3 ? 'fair' : 'poor';
}

const NOT_JUDGED = 'not judged: the runs gave too little to judge';

export function MarkMeter({
  kind,
  mark,
  className,
}: {
  kind: keyof typeof MARK_HINT;
  /** Null when the analysis found too little to judge. */
  mark: number | null;
  className?: string;
}): React.JSX.Element {
  const label = kind === 'usefulness' ? 'Usefulness' : 'Quality';
  const tone = mark === null ? null : toneOf(mark);
  return (
    <span
      data-slot="mark-meter"
      data-mark={mark ?? 'none'}
      role="img"
      aria-label={
        mark === null ? `${label} not judged` : `${label} ${mark} of 5`
      }
      title={
        mark === null ? `${MARK_HINT[kind]} — ${NOT_JUDGED}` : MARK_HINT[kind]
      }
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] text-muted-foreground',
        className,
      )}>
      <span>{label}</span>
      <span aria-hidden="true" className="inline-flex gap-0.5">
        {[1, 2, 3, 4, 5].map((step) => (
          <span
            key={step}
            className={segment({
              tone:
                tone !== null && mark !== null && step <= mark ? tone : 'empty',
            })}
          />
        ))}
      </span>
      <span
        aria-hidden="true"
        className="font-medium text-foreground tabular-nums">
        {mark ?? '—'}
      </span>
    </span>
  );
}

export function MemberVerdictBadge({
  verdict,
}: {
  verdict: MemberVerdict;
}): React.JSX.Element {
  const badge = VERDICT_BADGE[verdict];
  return (
    <Badge
      data-slot="member-verdict"
      data-verdict={verdict}
      variant={badge.variant}
      title={badge.hint}>
      {badge.label}
    </Badge>
  );
}

/** An analysis's judgement of one member: its two marks and the verdict. */
export function MemberMarks({
  usefulness,
  quality,
  verdict,
  className,
}: {
  usefulness: number | null;
  quality: number | null;
  verdict: MemberVerdict;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      data-slot="member-marks"
      className={cn(
        'inline-flex flex-wrap items-center gap-x-3 gap-y-1',
        className,
      )}>
      <MarkMeter kind="usefulness" mark={usefulness} />
      <MarkMeter kind="quality" mark={quality} />
      <MemberVerdictBadge verdict={verdict} />
    </span>
  );
}
