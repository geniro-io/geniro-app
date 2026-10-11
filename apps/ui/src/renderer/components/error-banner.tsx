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
  icon = null,
  announce = 'alert',
  size = 'default',
  onDismiss,
  className,
  ...rest
}: {
  message: string;
  /** Defaults to `error`, so every existing caller is unchanged. */
  tone?: BannerTone;
  /** A recovery control rendered before the close button, e.g. a delete. */
  action?: React.ReactNode;
  /** A glyph ahead of the message, saying what KIND of notice this is. */
  icon?: React.ReactNode;
  /**
   * How a screen reader hears the message. `alert` interrupts, which is right
   * for a failure that just happened; `status` waits its turn, which is right
   * for a notice whose text keeps moving (a countdown would otherwise be
   * re-announced on every tick, over whatever the user was listening to).
   */
  announce?: 'alert' | 'status';
  /**
   * `sm` is the compact strip for a notice that sits INSIDE another control
   * (the composer's cache warning) rather than across a screen.
   */
  size?: 'default' | 'sm';
  onDismiss: () => void;
  className?: string;
} & Omit<
  React.ComponentProps<'div'>,
  'children' | 'className' | 'role'
>): React.JSX.Element {
  const warning = tone === 'warning';
  const sm = size === 'sm';
  return (
    <div
      {...rest}
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
        'flex items-start rounded-md',
        sm ? 'gap-1.5 px-2.5 py-1.5' : 'gap-2 px-3 py-2',
        warning ? 'bg-warning/10' : 'bg-destructive/10',
        className,
      )}>
      {icon !== null ? (
        <span
          aria-hidden
          className={cn(
            // As tall as one line of the message, so the glyph centres on the
            // first line however many lines the message wraps to.
            'flex shrink-0 items-center',
            sm ? 'h-4 [&>svg]:size-3.5' : 'h-5 [&>svg]:size-4',
            warning ? 'text-warning' : 'text-destructive',
          )}>
          {icon}
        </span>
      ) : null}
      {/* `break-words`: daemon failures carry a full route and body, and an
          unbroken one would otherwise widen the strip past its container. */}
      <ErrorText
        role={announce}
        className={cn(
          'min-w-0 flex-1 break-words',
          sm && 'text-xs leading-4',
          warning && 'text-warning',
        )}>
        {message}
      </ErrorText>
      {action}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          // The button is taller than a line of text, and with `items-start`
          // it set the row's height: the text sat at the top with the padding
          // plus the difference below it — 8px above, 12px below. The negative
          // margin keeps its hit area and takes the difference back, so the
          // row is one line tall and the padding is the same on both sides.
          sm ? '-my-0.5 size-5' : '-my-0.5 size-6',
          'shrink-0',
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
        <X className={cn('shrink-0', sm ? 'size-3' : 'size-3.5')} />
      </Button>
    </div>
  );
}
