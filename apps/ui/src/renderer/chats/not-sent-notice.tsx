import { CircleSlash } from 'lucide-react';

import { Button } from '../components/ui/button';
import { offerLink } from './git-notice-offers';

/**
 * The line under a user message the agent never received — its turn ended
 * before the agent took it, or its CLI refused it — with the one thing the
 * user can do.
 */
export function NotSentNotice({
  reason,
  onResend,
}: {
  /** What the CLI said refusing it; null when its turn simply ended first. */
  reason: string | null;
  /** Absent where this surface cannot send: the line still says what happened. */
  onResend: (() => void) | null;
}): React.JSX.Element {
  return (
    <div
      data-slot="not-sent-notice"
      className="mt-1 flex items-center gap-1.5 text-xs text-warning">
      <CircleSlash aria-hidden className="size-3.5" />
      <span>
        {reason === null
          ? 'Not sent — the turn ended before the agent took it'
          : `Not sent — the agent refused it (${reason})`}
      </span>
      {onResend !== null ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className={offerLink({ tone: 'warning' })}
          onClick={onResend}>
          Resend
        </Button>
      ) : null}
    </div>
  );
}
