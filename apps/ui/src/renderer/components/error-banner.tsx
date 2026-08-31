import { X } from 'lucide-react';
import * as React from 'react';

import { ErrorText } from './error-text';
import { Button } from './ui/button';
import { cn } from './ui/utils';

/**
 * How loudly the strip speaks.
 *
 * `warning` exists because not everything the app has to say in this shape is a
 * failure: a guard that refused to switch branch over uncommitted work is the
 * app doing its job on a tree the user is mid-edit in, and painting that red
 * told them something had gone wrong. Same strip, same dismiss, same place —
 * only the tone and the word the close button uses differ.
 */
export type BannerTone = 'error' | 'warning';

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
  tone = 'error',
  action = null,
  onDismiss,
  className,
}: {
  message: string;
  /** Defaults to `error`, so every existing caller is unchanged. */
  tone?: BannerTone;
  /** A recovery control rendered before the close button, e.g. a delete. */
  action?: React.ReactNode;
  onDismiss: () => void;
  className?: string;
}): React.JSX.Element {
  const warning = tone === 'warning';
  return (
    <div
      data-tone={tone}
      className={cn(
        // The strip carries its OWN surface, and that is what makes the
        // far-edge close control legible as part of it.
        //
        // Without one it was bare text and a ✕ on the page's own ground, with
        // `flex-1` holding them apart: measured in the catalog at 224px of
        // nothing between a 174px message and the button, in a 420px strip —
        // and on Stats, where the strip runs the page width, the gap is the
        // whole content column. Reported as "a lot of margin between text and
        // icon", and the margin was never the defect: nothing tied the two
        // ends together, so a conventional banner layout read as a stray
        // glyph parked at the far edge.
        //
        // Padding is the component's now, so a caller insets with MARGIN —
        // one that keeps passing `px-*` merges away this padding and puts the
        // text back on the fill's own edge.
        'flex items-start gap-2 rounded-md px-3 py-2',
        warning ? 'bg-warning/10' : 'bg-destructive/10',
        className,
      )}>
      {/* `break-words`: daemon failures carry a full route and body, and an
          unbroken one would otherwise widen the strip past its container. */}
      <ErrorText
        className={cn('min-w-0 flex-1 break-words', warning && 'text-warning')}>
        {message}
      </ErrorText>
      {action}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          'size-6 shrink-0',
          warning
            ? 'text-warning hover:text-warning'
            : 'text-destructive hover:text-destructive',
        )}
        // The accessible name follows the tone: "Dismiss error" on a strip that
        // reports no error is the kind of small lie a screen-reader user has no
        // way to check.
        aria-label={warning ? 'Dismiss warning' : 'Dismiss error'}
        title="Dismiss"
        onClick={onDismiss}>
        <X className="size-3.5 shrink-0" />
      </Button>
    </div>
  );
}
