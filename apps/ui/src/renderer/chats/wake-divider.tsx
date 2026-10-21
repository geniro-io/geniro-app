import { RotateCw } from 'lucide-react';
import { Fragment, useContext } from 'react';

import { RevealCallContext } from './call-block';
import type { WakeReason } from './wake-payload';

/** The rule, icon, text, rule line every "picked back up" divider is drawn as. */
export function PickedBackUpLine({
  slot,
  children,
}: {
  slot: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot={slot}
      role="note"
      className="flex w-full items-center gap-2 py-1 text-xs text-muted-foreground">
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
      <RotateCw aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 text-center">{children}</span>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}

/** The woken agent's name, or "The agent" where it has none. */
export function AgentName({
  name,
}: {
  name: string | null;
}): React.JSX.Element {
  return (
    <span className="font-medium text-foreground/80">
      {name ?? 'The agent'}
    </span>
  );
}

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
    <PickedBackUpLine slot="wake-divider">
      <AgentName name={caller} /> picked back up —{' '}
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
    </PickedBackUpLine>
  );
}
