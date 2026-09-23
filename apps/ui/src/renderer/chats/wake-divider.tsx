import { RotateCw } from 'lucide-react';
import { Fragment, useContext } from 'react';

import { RevealCallContext } from './call-block';
import type { WakeReason } from './wake-payload';

/**
 * Where a caller was started again because a call of its own finished or asked
 * something after its turn had ended — drawn as the agent picking the work back
 * up, with each call a link to its card, which is usually far above.
 */
export function WakeDivider({
  caller,
  reasons,
}: {
  /** The woken agent's display name, or null where it has none. */
  caller: string | null;
  reasons: readonly WakeReason[];
}): React.JSX.Element {
  const reveal = useContext(RevealCallContext);
  return (
    <div
      data-slot="wake-divider"
      role="note"
      className="flex w-full items-center gap-2 py-1 text-xs text-muted-foreground">
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
      <RotateCw aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 text-center">
        <span className="font-medium text-foreground/80">
          {caller ?? 'The agent'}
        </span>{' '}
        picked back up —{' '}
        {reasons.map((reason, index) => {
          const text = `${reason.callee} ${reason.reason === 'asked' ? 'asked a question in' : 'finished'} ${reason.callId}`;
          const open = reveal?.(reason.callId) ?? null;
          return (
            <Fragment key={reason.callId}>
              {index > 0 ? '; ' : null}
              {open === null ? (
                text
              ) : (
                <button
                  type="button"
                  data-slot="wake-divider-call"
                  title="Show this call in the conversation"
                  className="cursor-pointer text-xs underline decoration-dotted underline-offset-2 hover:text-foreground"
                  onClick={open}>
                  {text}
                </button>
              )}
            </Fragment>
          );
        })}
      </span>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}
