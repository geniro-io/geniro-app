import type { LucideIcon } from 'lucide-react';

import { cn } from '../components/ui/utils';
import { EventLine } from './agent-event-card';

/**
 * A card the manager's chat draws by itself, with no turn behind it: one event
 * line naming what it is about, then its body. Settled once nothing in it
 * waits on the user any more.
 */
export function NoticeCard({
  slot,
  kind,
  icon,
  label,
  heading,
  settled = false,
  settledIcon = icon,
  settledLabel = label,
  children,
}: {
  slot: string;
  kind: string;
  icon: LucideIcon;
  label: string;
  heading: string;
  settled?: boolean;
  settledIcon?: LucideIcon;
  settledLabel?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot={`${slot}-card`}
      data-kind={kind}
      data-decided={settled ? '' : undefined}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-card border border-border border-l-2 bg-card px-3 py-2',
        settled ? 'border-l-success/50 opacity-80' : 'border-l-warning/50',
      )}>
      <EventLine
        icon={settled ? settledIcon : icon}
        tone={settled ? 'success' : 'warning'}
        label={settled ? settledLabel : label}
        slot={slot}
        member={heading}
      />
      {children}
    </div>
  );
}
