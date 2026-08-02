import { X } from 'lucide-react';
import * as React from 'react';

import { ErrorText } from './error-text';
import { Button } from './ui/button';
import { cn } from './ui/utils';

/**
 * A dismissible error strip: the message, an optional recovery action, and a
 * close button.
 *
 * {@link ErrorText} alone is the right shape for a form field, where the error
 * clears itself the moment the input changes. A strip pinned to a screen is
 * not: nothing the user can type clears "could not load the workflow", so
 * without a close control the failure sits on screen for the rest of the
 * session — which is exactly what it did.
 *
 * `action` is for the case where the app knows a way out of the failure and can
 * offer it in place, instead of describing a dead end.
 */
export function ErrorBanner({
  message,
  action = null,
  onDismiss,
  className,
}: {
  message: string;
  /** A recovery control rendered before the close button, e.g. a delete. */
  action?: React.ReactNode;
  onDismiss: () => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex items-start gap-2', className)}>
      {/* `break-words`: daemon failures carry a full route and body, and an
          unbroken one would otherwise widen the strip past its container. */}
      <ErrorText className="min-w-0 flex-1 break-words">{message}</ErrorText>
      {action}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 shrink-0 text-destructive hover:text-destructive"
        aria-label="Dismiss error"
        title="Dismiss"
        onClick={onDismiss}>
        <X className="size-3.5 shrink-0" />
      </Button>
    </div>
  );
}
