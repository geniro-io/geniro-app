import { cn } from './ui/utils';

/**
 * The band the opener floats in, matching `TitleBar`'s own `h-11` (44px).
 *
 * The button is CENTRED in it by the same flexbox the title bar centres its
 * own controls with, rather than by an offset computed from the two heights.
 * Both openers used to carry `top-2` with a `size-9` button — 8 + 36 = 44,
 * so the bottom edge landed exactly on the band's border: 8px of air above
 * and none below, which is what "not in the middle vertically" looks like
 * (measured on the running remote page at 7.5px above, 0 below). An offset
 * has to be re-derived every time either height moves; a flex centre does
 * not.
 *
 * `sm:hidden` because at `sm` and wider both drawers are ordinary columns
 * already on screen — and the Electron window's own `minWidth` is 960, so
 * this is a LAN-gateway surface in a phone browser and nothing else.
 */
const BAND_CLASS = 'fixed top-0 z-50 flex h-11 items-center sm:hidden';

/** The button itself — the one place this look is written. */
const BUTTON_CLASS =
  'flex size-9 items-center justify-center rounded-md border border-border bg-card text-foreground shadow-panel-sm';

/**
 * The phone drawer opener: a floating button pinned inside the title bar's
 * band. The app shell's nav rail and the chat list each have one (see
 * `App.tsx` and `chats/Chats.tsx`), and they sit side by side — which is why
 * the horizontal placement is the caller's (`className`) while the vertical
 * placement, the size and the look are this component's. Two hand-rolled
 * copies of that class string is how one of them came to be centred and the
 * other not.
 */
export function DrawerOpener({
  label,
  expanded,
  onClick,
  className,
  children,
}: {
  /** The accessible name — this button's only label, since it carries an icon alone. */
  label: string;
  /** Passed through as `aria-expanded`; omit for an opener that only ever opens. */
  expanded?: boolean;
  onClick: () => void;
  /** Where in the band it sits, and any z-index the caller's stacking needs. */
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn(BAND_CLASS, className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={expanded}
        onClick={onClick}
        className={BUTTON_CLASS}>
        {children}
      </button>
    </div>
  );
}
