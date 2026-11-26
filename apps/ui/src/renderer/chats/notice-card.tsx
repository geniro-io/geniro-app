import { ChevronDown, type LucideIcon, X } from 'lucide-react';

import { ThreadActionButton } from '../components/thread-head';
import { cn } from '../components/ui/utils';
import { EventLine } from './agent-event-card';
import type { CardDismissal } from './settings-attention';

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
  dismissal,
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
  dismissal?: CardDismissal;
  children: React.ReactNode;
}): React.JSX.Element {
  const folded = dismissal?.folded === true;
  const line = (
    <EventLine
      icon={settled ? settledIcon : icon}
      tone={settled ? 'success' : 'warning'}
      label={settled ? settledLabel : label}
      slot={slot}
      member={heading}
    />
  );
  return (
    <div
      data-slot={`${slot}-card`}
      data-kind={kind}
      data-decided={settled ? '' : undefined}
      data-dismissed={folded ? '' : undefined}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-card border border-border border-l-2 bg-card px-3 py-2',
        settled ? 'border-l-success/50 opacity-80' : 'border-l-warning/50',
      )}>
      {dismissal === undefined ? (
        line
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">{line}</div>
          <div className="flex shrink-0 items-center gap-1">
            {folded ? (
              <ThreadActionButton
                slot={`${slot}-show`}
                label={`Show ${heading}`}
                title="Show this card again"
                icon={<ChevronDown aria-hidden="true" />}
                onClick={dismissal.show}>
                Show
              </ThreadActionButton>
            ) : (
              <ThreadActionButton
                slot={`${slot}-dismiss`}
                label={`Dismiss ${heading}`}
                title="Fold this card to one line on this device"
                icon={<X aria-hidden="true" />}
                onClick={dismissal.dismiss}>
                Dismiss
              </ThreadActionButton>
            )}
          </div>
        </div>
      )}
      {folded ? null : children}
    </div>
  );
}
