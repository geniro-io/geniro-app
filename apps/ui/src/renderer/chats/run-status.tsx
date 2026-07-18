import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Loader2,
  MinusCircle,
} from 'lucide-react';

import { cn } from '../components/ui/utils';

/**
 * Everything a run or a node can be, display-wise: the run statuses plus the
 * node-only `skipped` and the "hasn't started yet" `idle`.
 */
export type RunStatusKind =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'idle';

/**
 * The one status → icon/tone mapping, so a run's or agent's state reads the
 * same everywhere (sidebar rows, the transcript header, the agents panel):
 * running spins in the accent tone, terminal states are
 * success/destructive/muted.
 */
export const RUN_STATUS_META: Record<
  RunStatusKind,
  { icon: typeof Clock; className: string }
> = {
  pending: { icon: Clock, className: 'text-muted-foreground' },
  running: { icon: Loader2, className: 'text-primary' },
  completed: { icon: CircleCheck, className: 'text-success' },
  failed: { icon: CircleX, className: 'text-destructive' },
  cancelled: { icon: Ban, className: 'text-muted-foreground' },
  skipped: { icon: MinusCircle, className: 'text-muted-foreground' },
  idle: { icon: CircleDashed, className: 'text-muted-foreground' },
};

/** The status glyph alone — spinning while running. */
export function RunStatusIcon({
  status,
  className,
}: {
  status: RunStatusKind;
  className?: string;
}): React.JSX.Element {
  const meta = RUN_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        'size-3 shrink-0',
        meta.className,
        status === 'running' && 'animate-spin',
        className,
      )}
    />
  );
}
