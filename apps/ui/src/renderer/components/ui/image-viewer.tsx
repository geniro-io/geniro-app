import {
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  Scan,
  Shrink,
} from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';
import {
  type ReactZoomPanPinchContentRef,
  TransformComponent,
  TransformWrapper,
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
 * `label` is null at fit, and its reader draws NO control there rather than a
 * disabled one: a reading nobody can act on is chrome, and the disabled button
 * it used to render wore a glyph that promised full screen.
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
 * Its own component because the live magnification is read through
 * {@link useTransformComponent}, which only resolves inside
 * {@link TransformWrapper}.
 *
 * The ACTIONS come off the wrapper's own ref rather than `useControls()`, and
 * that is a fix rather than a preference: the hook's handles were destructured
 * once at mount, when the wrapper had not yet attached its instance, so every
 * button on this bar called a no-op for the life of the viewer. Driven in the
 * running app — a wheel gesture (which the library serves through its own native
 * listener, bypassing the hook) zoomed to 800%, while `Zoom in`, `Zoom out` and
 * the reset moved nothing at all. Reading `apiRef.current` at CALL time cannot
 * capture a null instance.
 */
function ZoomControls({
  stageRef,
  api,
}: {
  /** The box the fullscreen control hands to the browser — see the button. */
  stageRef: React.RefObject<HTMLElement | null>;
  /** The wrapper's own handle — see {@link ImageViewer} for why not `useControls`. */
  api: ReactZoomPanPinchContentRef;
}): React.JSX.Element {
  const scale = useTransformComponent(({ state }) => state.scale);
  const { atFit, atMax, label } = zoomControlState(scale);
  const fullscreen = useFullscreen(stageRef);

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
        onClick={() => api.zoomOut()}>
        <Minus className="size-4" />
      </Button>
      {/* The reading IS the reset control: a percentage the user can read and a
          button they can press are the same affordance here, and a separate
          reset icon would need a label explaining which of the two it undoes.

          Rendered ONLY while there is something to reset. It used to stand at
          fit as a DISABLED button wearing a `Scan` glyph — a square with corner
          brackets, which reads as "full screen" everywhere else — so the one
          control on the bar that looked like it opened the picture up was the
          one that could not be pressed. REPORTED as exactly that ("Бончок на
          полный экран тоже снизу не работает"). The glyph now belongs to the
          control that really does it, below. */}
      {atFit ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 min-w-14 px-1.5 text-xs tabular-nums text-muted-foreground"
          aria-label="Reset zoom to fit"
          onClick={() => api.resetTransform()}>
          {label}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        aria-label="Zoom in"
        disabled={atMax}
        onClick={() => api.zoomIn()}>
        <Plus className="size-4" />
      </Button>
      {/* FULL SCREEN, and a real one: the browser's own, over the stage that
          holds the picture and this bar — so the controls come with it rather
          than being left behind on a page nobody can see. Never disabled, which
          is the point of it existing separately from the reset above. */}
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        aria-label={fullscreen.active ? 'Leave full screen' : 'Full screen'}
        aria-pressed={fullscreen.active}
        onClick={fullscreen.toggle}>
        {fullscreen.active ? (
          <Shrink className="size-4" />
        ) : (
          <Scan className="size-4" />
        )}
      </Button>
    </div>
  );
}

/**
 * How far the pointer may travel between press and release and still count as a
 * CLICK rather than the end of a pan.
 *
 * Without it every drag would zoom on release, which is the one way a
 * click-to-zoom surface can make panning unusable — and the two gestures share a
 * button, so nothing else can tell them apart.
 */
const CLICK_SLOP_PX = 5;

/** What one click multiplies the scale by — the wheel's step is far finer. */
const CLICK_ZOOM_STEP = 2;

/**
 * The picture itself: click to zoom AT THE POINTER, drag to pan.
 *
 * REPORTED as "сейчас у нас снизу есть плюсик и минусик, но я хочу, чтобы это
 * было с курсором… когда ты нажимаешь, он приближает". The buttons stay — they
 * are the keyboard's only way in, and `+`/`−` is what a reader looks for — but
 * they stop being the only way, and the cursor now says so before the click.
 *
 * Zooming AT THE POINTER rather than at the centre is the whole point: the
 * library's own `zoomIn` grows the picture about its middle, so clicking a
 * detail in a corner pushes that detail further away. The arithmetic keeps the
 * clicked content point exactly where it was — convert it to content space at
 * the current scale, then place it back under the same pixel at the next one.
 *
 * A click at MAX resets to fit, so one gesture cycles rather than dead-ending at
 * 8× with no way back that does not involve the bar.
 */
function ZoomableSurface({
  src,
  alt,
  api,
}: {
  src: string;
  alt?: string;
  /** The wrapper's own handle — see {@link ImageViewer}. */
  api: ReactZoomPanPinchContentRef;
}): React.JSX.Element {
  const scale = useTransformComponent(({ state }) => state.scale);
  const positionX = useTransformComponent(({ state }) => state.positionX);
  const positionY = useTransformComponent(({ state }) => state.positionY);
  const zoomed = !isAtFit(scale);
  const atMax = scale >= MAX_SCALE;
  const pressRef = React.useRef<{ x: number; y: number } | null>(null);

  const onClick = (event: React.MouseEvent): void => {
    const press = pressRef.current;
    pressRef.current = null;
    if (
      press !== null &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) >
        CLICK_SLOP_PX
    ) {
      return;
    }
    if (atMax) {
      api.resetTransform();
      return;
    }
    // The library's OWN viewport element, never this component's wrapper: the
    // wrapper is `display: contents` and therefore has no box at all, and it is
    // that way on purpose — see the element below.
    const box = api.instance.wrapperComponent?.getBoundingClientRect();
    if (box === undefined) {
      return;
    }
    const next = Math.min(MAX_SCALE, scale * CLICK_ZOOM_STEP);
    // Where the click landed inside the viewport box, and the CONTENT point
    // under it. `positionX/Y` is the content's offset within that box, so
    // dividing by the scale converts a screen pixel into a point on the picture.
    const pointerX = event.clientX - box.left;
    const pointerY = event.clientY - box.top;
    const contentX = (pointerX - positionX) / scale;
    const contentY = (pointerY - positionY) / scale;
    api.setTransform(
      pointerX - contentX * next,
      pointerY - contentY * next,
      next,
    );
  };

  return (
    // `display: contents`, which is load-bearing rather than tidy. An ordinary
    // wrapper here BREAKS the library: it re-resolves the percentage widths its
    // content is sized by, and the picture then overflows its own viewport —
    // measured in the running app at a 1519px image inside a 921px wrapper,
    // after which the bounds math is nonsense and every control that clamps
    // against it silently does nothing. `contents` puts the handlers in the tree
    // while leaving the layout exactly as the library laid it out.
    <div
      data-slot="image-viewer-surface"
      className="contents"
      onPointerDown={(event) => {
        pressRef.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={onClick}>
      <TransformComponent
        wrapperClass={cn(
          '!w-full !max-w-full overflow-hidden rounded-md',
          // The cursors live HERE, on the element that still has a box.
          // The MAGNIFIER is the half of this the report actually named;
          // `zoom-out` at the ceiling because that is what the click does
          // there, and a `zoom-in` cursor over a picture that cannot grow is a
          // promise the gesture breaks.
          atMax ? 'cursor-zoom-out' : 'cursor-zoom-in',
          // Panning is still the other gesture, and the grabbing cursor says so
          // DURING the drag — `cursor-grab` at rest would overwrite the
          // magnifier and take the click's own affordance away.
          zoomed && 'active:cursor-grabbing',
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
    </div>
  );
}

/**
 * Whether `element` is the one the browser is showing full-screen, and the
 * toggle for it.
 *
 * Its own hook because the browser owns this state: nothing here can set it, and
 * every way OUT of full screen — Escape, the system control, another element
 * taking over — happens without this component being told. Reading the event is
 * the only way the button's own label can stay true.
 */
function useFullscreen(ref: React.RefObject<HTMLElement | null>): {
  active: boolean;
  toggle: () => void;
} {
  const [active, setActive] = React.useState(false);
  React.useEffect(() => {
    const sync = (): void =>
      setActive(
        ref.current !== null && document.fullscreenElement === ref.current,
      );
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [ref]);
  const toggle = React.useCallback(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    // Both directions can reject — a browser that refuses the request, an exit
    // raced by something else taking the screen. Neither is worth an error on a
    // picture viewer, and the `fullscreenchange` listener above is what keeps
    // the label honest either way.
    if (document.fullscreenElement === element) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void element.requestFullscreen().catch(() => undefined);
  }, [ref]);
  return { active, toggle };
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
  /** The box the full-screen control hands to the browser — see `ZoomControls`. */
  const stageRef = React.useRef<HTMLDivElement>(null);

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
      <div ref={stageRef} className="relative bg-card">
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
          {/* The RENDER-PROP child, which is the only route to the library's
              API that actually binds here. `useControls()` hands back handles
              captured before the wrapper attaches its instance, and both `ref`
              and `onInit` left it null — verified in the running app, where the
              wheel zoomed to 800% while every button and the click did nothing,
              and the Full screen control in the same component worked, so React
              itself was fine. The API arrives as an argument here, so there is
              nothing to be null. */}
          {(api) => (
            <>
              <ZoomControls stageRef={stageRef} api={api} />
              <ZoomableSurface src={src} alt={alt} api={api} />
            </>
          )}
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
