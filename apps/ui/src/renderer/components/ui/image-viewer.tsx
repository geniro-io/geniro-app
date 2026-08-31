import { ChevronLeft, ChevronRight, Minus, Plus, Scan } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';
import {
  TransformComponent,
  TransformWrapper,
  useControls,
  useTransformComponent,
} from 'react-zoom-pan-pinch';

import { Button } from './button';
import { Dialog } from './dialog';
import { cn } from './utils';

/** Fit-to-window. The picture never zooms out past the size it opened at. */
const MIN_SCALE = 1;
const MAX_SCALE = 8;

/**
 * Whether the picture is at rest, within the float slop an animated zoom leaves
 * behind.
 *
 * One predicate rather than the comparison spelled at each reader: the controls
 * that disable at fit and the grab cursor that appears once zoomed are exact
 * complements, so two copies of the epsilon would eventually give a picture a
 * grab cursor while its reset button says there is nothing to reset.
 */
const FIT_EPSILON = 0.001;
const isAtFit = (scale: number): boolean => scale <= MIN_SCALE + FIT_EPSILON;

/**
 * What the zoom controls should say and offer at one magnification.
 *
 * Pulled out of the component because it is the only part of the zoom a unit
 * test can reach: jsdom measures every box 0×0, so the scale the library
 * actually arrives at is unobservable there, while the DECISION taken from a
 * scale is pure and worth pinning at more than its resting value.
 *
 * `label` is null at fit — the control shows a fit glyph rather than `100%`,
 * because a reading nobody can act on is chrome.
 */
export function zoomControlState(scale: number): {
  atFit: boolean;
  atMax: boolean;
  label: string | null;
} {
  const atFit = isAtFit(scale);
  return {
    atFit,
    atMax: scale >= MAX_SCALE,
    label: atFit ? null : `${Math.round(scale * 100)}%`,
  };
}

/**
 * The look of a control that opens a picture full-screen.
 *
 * Exported because {@link ZoomableImage} cannot serve every opener — it owns its
 * own `open` state, so a caller that must CONTROL which picture is showing (the
 * gallery card, stepping through a set) has to render its own trigger. Sharing
 * the class string is what stops that trigger drifting from this one.
 *
 * The ring is INSET, unlike every other control's: the thumbnail call sites sit
 * in an `overflow-hidden` frame, which clips a ring drawn outside the box and
 * leaves a keyboard user with no visible focus at all.
 */
export const ZOOMABLE_TRIGGER_CLASS =
  'cursor-zoom-in outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset';

/**
 * The zoom controls, and the live magnification.
 *
 * Its own component because {@link useControls} only resolves inside
 * {@link TransformWrapper} — the handles are read off the context that wrapper
 * provides, so a caller outside it gets nothing to call.
 */
function ZoomControls(): React.JSX.Element {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  const scale = useTransformComponent(({ state }) => state.scale);
  const { atFit, atMax, label } = zoomControlState(scale);

  return (
    <div
      data-slot="image-viewer-controls"
      // `z-10` is load-bearing rather than decorative: the transform surface is
      // a sibling rendered AFTER this bar and fills the whole box, so in plain
      // DOM order it paints over these buttons and swallows their clicks — the
      // bar is visible and simply does not respond. Only reachable in a real
      // browser (jsdom computes no layout and no stacking), so nothing in the
      // spec suite can hold this; the comment is what keeps it.
      className="pointer-events-auto absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border bg-card/90 p-1 shadow-panel-md backdrop-blur-sm">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        aria-label="Zoom out"
        disabled={atFit}
        onClick={() => zoomOut()}>
        <Minus className="size-4" />
      </Button>
      {/* The reading IS the reset control: a percentage the user can read and a
          button they can press are the same affordance here, and a separate
          reset icon would need a label explaining which of the two it undoes. */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 min-w-14 px-1.5 text-xs tabular-nums text-muted-foreground"
        aria-label="Reset zoom to fit"
        disabled={atFit}
        onClick={() => resetTransform()}>
        {label ?? <Scan className="size-4" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        aria-label="Zoom in"
        disabled={atMax}
        onClick={() => zoomIn()}>
        <Plus className="size-4" />
      </Button>
    </div>
  );
}

/** The picture itself, plus the grab cursor that only means something zoomed in. */
function ZoomableSurface({
  src,
  alt,
}: {
  src: string;
  alt?: string;
}): React.JSX.Element {
  const zoomed = useTransformComponent(({ state }) => !isAtFit(state.scale));

  return (
    <TransformComponent
      wrapperClass={cn(
        '!w-full !max-w-full overflow-hidden rounded-md',
        zoomed && 'cursor-grab active:cursor-grabbing',
      )}
      contentClass="!w-full">
      <img
        data-slot="image-viewer-image"
        src={src}
        alt={alt ?? ''}
        draggable={false}
        className="mx-auto max-h-[min(78vh,100%)] w-auto max-w-full rounded-md object-contain"
      />
    </TransformComponent>
  );
}

/**
 * One image at the size the window allows, over a modal backdrop — zoomable,
 * pannable, and resettable to the size it opened at.
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
 *
 * Zoom rides `react-zoom-pan-pinch` rather than a hand-rolled transform. The
 * part worth buying is not the `scale` — it is keeping the point under the
 * cursor fixed while the scale changes, and clamping the pan to the scaled
 * bounds so the picture can never be dragged out of its own frame.
 */
export function ImageViewer({
  open,
  onClose,
  src,
  alt,
  title,
  onPrev,
  onNext,
  position,
}: {
  open: boolean;
  onClose: () => void;
  src: string;
  alt?: string;
  /** Named in the header — a file name or the reference the agent wrote. */
  title?: string;
  /**
   * Step to the neighbouring picture, when this viewer was opened over a SET.
   *
   * Optional so the single-image case — a markdown image, a pasted attachment —
   * is untouched: absent, no arrows are drawn and the arrow keys do nothing.
   * They live HERE rather than in a second gallery-owned modal because the
   * modal contract is the expensive part and it already lives in {@link Dialog}
   * below; a lightbox of its own would be the second implementation this
   * component's own doc block exists to prevent.
   */
  onPrev?: () => void;
  onNext?: () => void;
  /** `{index, count}` for the "3 of 8" readout. Absent for a lone picture. */
  position?: { index: number; count: number };
}): React.JSX.Element | null {
  const browsing = onPrev !== undefined || onNext !== undefined;

  React.useEffect(() => {
    if (!open || !browsing) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft') {
        onPrev?.();
      } else if (event.key === 'ArrowRight') {
        onNext?.();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, browsing, onPrev, onNext]);

  if (!open) {
    return null;
  }
  return createPortal(
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="block truncate" title={title}>
            {title ?? alt ?? 'Image'}
          </span>
          {position === undefined ? null : (
            <span
              data-slot="image-viewer-position"
              className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
              {position.index + 1} of {position.count}
            </span>
          )}
        </span>
      }
      // `w-fit` overrides `Dialog`'s own `w-full`: every other dialog holds a
      // form, which wants the whole card, while this one holds a picture whose
      // size is the picture's. A 100×50 image in a 64rem card is a postage
      // stamp adrift in an empty window.
      className="w-fit max-w-[min(92vw,64rem)]">
      <div className="relative">
        <TransformWrapper
          // KEYED ON THE PICTURE. The wrapper holds the scale and the offset in
          // its own state, so without this a set stepped through at 4× would
          // hand each new picture the previous one's transform — a screenshot
          // opening already zoomed into a corner of the last one.
          key={src}
          minScale={MIN_SCALE}
          maxScale={MAX_SCALE}
          initialScale={MIN_SCALE}
          centerOnInit
          // `limitToBounds` is what makes MIN_SCALE mean fit-to-window: the
          // content can be pushed no further than its own scaled edges, so a
          // picture at rest cannot be dragged off into empty card.
          limitToBounds
          wheel={{ step: 0.12 }}
          doubleClick={{ mode: 'toggle', step: 1.5 }}>
          <ZoomControls />
          <ZoomableSurface src={src} alt={alt} />
        </TransformWrapper>
        {browsing ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Previous image"
              disabled={onPrev === undefined}
              onClick={onPrev}
              className="absolute top-1/2 left-2 size-8 -translate-y-1/2 rounded-full opacity-80 hover:opacity-100">
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Next image"
              disabled={onNext === undefined}
              onClick={onNext}
              className="absolute top-1/2 right-2 size-8 -translate-y-1/2 rounded-full opacity-80 hover:opacity-100">
              <ChevronRight className="size-4" />
            </Button>
          </>
        ) : null}
      </div>
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
        className={cn(ZOOMABLE_TRIGGER_CLASS, className)}>
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
