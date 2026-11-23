import { cva } from 'class-variance-authority';
import {
  CircleCheckBig,
  type LucideIcon,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';

import type { MilestoneKind, MilestonePayload } from './milestone-payload';

const KIND_VIEW: Record<MilestoneKind, { label: string; Icon: LucideIcon }> = {
  progress: { label: 'Step', Icon: Sparkles },
  problem: { label: 'Problem found', Icon: TriangleAlert },
  done: { label: 'Done', Icon: CircleCheckBig },
};

const badgeVariants = cva(
  'flex size-5 shrink-0 items-center justify-center rounded-md',
  {
    variants: {
      kind: {
        progress: 'bg-accent text-accent-foreground',
        problem: 'bg-warning/10 text-warning',
        done: 'bg-success/15 text-success',
      },
    },
  },
);

/**
 * A step an agent reported to its run's timeline (`milestone`), as one compact
 * line in the transcript. The icon and its words name the kind; the colour
 * only repeats it.
 */
export function MilestoneRow({
  milestone,
  author,
  time,
}: {
  milestone: MilestonePayload;
  /** The reporting member's name, or null in a chat with no team. */
  author: string | null;
  time?: string;
}): React.JSX.Element {
  const { label, Icon } = KIND_VIEW[milestone.kind];
  return (
    <div
      data-slot="milestone"
      data-kind={milestone.kind}
      className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1 text-xs">
      <span className={badgeVariants({ kind: milestone.kind })}>
        <span className="sr-only">{label}</span>
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <p className="m-0 min-w-0 break-words">
          <span className="font-semibold text-foreground">
            {author ?? 'Agent'}
          </span>{' '}
          <span className="text-muted-foreground">{milestone.text}</span>
        </p>
        {time === undefined || time === '' ? null : (
          <time className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground tabular-nums">
            {time}
          </time>
        )}
      </div>
    </div>
  );
}
