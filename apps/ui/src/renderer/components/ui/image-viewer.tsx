import * as React from 'react';
import { createPortal } from 'react-dom';

import { Dialog } from './dialog';
import { cn } from './utils';

/**
 * One image at the size the window allows, over a modal backdrop.
 *
 * Built on {@link Dialog} rather than beside it: the modal contract — Escape,
 * backdrop click, the focus trap and restoring focus to the opener — is the
 * expensive part and already lives there, and a second implementation of it
 * would be the one that drifts.
 *
 * PORTALLED to `document.body`, which the other dialogs do not need. Every
 * other dialog is opened from a screen; this one is opened from a thumbnail
 * buried in a transcript, where two things bite: `position: fixed` is resolved
 * against the nearest ancestor carrying a `transform`/`filter`/`will-change`
 * rather than the viewport, and a markdown image sits inside the `<p>` the
 * renderer wrapped it in, which is no place for a dialog's markup.
 */
export function ImageViewer({
  open,
  onClose,
  src,
  alt,
  title,
}: {
  open: boolean;
  onClose: () => void;
  src: string;
  alt?: string;
  /** Named in the header — a file name or the reference the agent wrote. */
  title?: string;
}): React.JSX.Element | null {
  if (!open) {
    return null;
  }
  return createPortal(
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="block truncate" title={title}>
          {title ?? alt ?? 'Image'}
        </span>
      }
      // `w-fit` overrides `Dialog`'s own `w-full`: every other dialog holds a
      // form, which wants the whole card, while this one holds a picture whose
      // size is the picture's. A 100×50 image in a 64rem card is a postage
      // stamp adrift in an empty window.
      className="w-fit max-w-[min(92vw,64rem)]">
      <img
        data-slot="image-viewer-image"
        src={src}
        alt={alt ?? ''}
        className="mx-auto max-h-[min(78vh,100%)] w-auto max-w-full rounded-md object-contain"
      />
    </Dialog>,
    document.body,
  );
}

/**
 * A thumbnail that opens {@link ImageViewer} when pressed.
 *
 * REPORTED as "all images should be clickable", and the sharpest case is the
 * transcript's attachment row: those thumbnails are `object-cover` squares, so
 * a screenshot — which is what people paste — is cropped to its middle and the
 * only copy of it in the app shows almost none of it.
 *
 * A `<button>` and not a `<div onClick>`: this is the one element in the app
 * whose whole purpose is to be pressed, so it has to be reachable by keyboard
 * and announce itself. It is also why the root is phrasing content — a
 * markdown image is rendered inside a paragraph, and a block element there is
 * markup no parser would have produced.
 *
 * Two class props because the two boxes are decided by different things: the
 * BUTTON carries the layout the call site imposes (a fixed square in a
 * thumbnail row, an intrinsic box in a message), the IMG carries how the
 * picture fills it (`object-cover` when the box is fixed, `object-contain`
 * when it is not).
 */
export function ZoomableImage({
  src,
  alt,
  title,
  className,
  imgClassName,
  imgSlot,
}: {
  src: string;
  alt?: string;
  /** Named in the viewer's header, and the button's own hover title. */
  title?: string;
  /** Layout classes for the button box. */
  className?: string;
  /** Appearance classes for the image inside it. */
  imgClassName?: string;
  /**
   * `data-slot` for the IMG. The button's own is fixed, but which picture this
   * is — a markdown reference, a pasted attachment — is the caller's fact, and
   * it is the `<img>` that carries the resolved `src` a test reads back.
   */
  imgSlot?: string;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const label = title ?? alt;

  return (
    <>
      <button
        type="button"
        data-slot="zoomable-image"
        title={label}
        aria-label={label ? `View ${label}` : 'View image'}
        onClick={() => setOpen(true)}
        className={cn(
          // The ring is INSET, unlike every other control's: both thumbnail
          // call sites sit in an `overflow-hidden` frame, which clips a ring
          // drawn outside the box and leaves a keyboard user with no visible
          // focus at all.
          'cursor-zoom-in outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
          className,
        )}>
        <img
          data-slot={imgSlot}
          src={src}
          alt={alt ?? ''}
          className={imgClassName}
        />
      </button>
      <ImageViewer
        open={open}
        onClose={() => setOpen(false)}
        src={src}
        alt={alt}
        title={title}
      />
    </>
  );
}
