import { cn } from './ui/utils';

/**
 * The backdrop closes the drawer on a tap outside it. `sm:hidden` as well as
 * the `open` gate, so a state left true from a phone-width session can never
 * paint a stray full-window overlay if the same window were ever widened
 * past `sm`.
 *
 * Its `z-40` and the panel's `z-50` below are a PAIR — the panel is always
 * above its own scrim — and must move together, which is the point of
 * stating both in the one component rather than in two files free to edit
 * either half alone.
 *
 * It starts at `top-11`, NOT `inset-0`, so it begins exactly where the panel
 * does. `TitleBar` is `bg-sidebar` — the same surface as the drawer's own
 * panel — and a scrim over it turned that black band a washed grey while the
 * drawer was open, with the drawer's opener and close buttons sitting in the
 * dimmed strip. Leaving the title bar out keeps the bar and the open panel
 * reading as ONE dark surface, which is what a drawer sliding out from under
 * the bar should look like; everything the drawer actually covers for is
 * below it.
 */
const BACKDROP_CLASS =
  'fixed inset-x-0 top-11 bottom-0 z-40 bg-foreground/40 sm:hidden';

/**
 * `top-11` tracks `TitleBar`'s own `h-11` (44px), so the panel is pinned
 * exactly under the title bar rather than covering the window's own
 * traffic-light buttons — see `title-bar.tsx`.
 *
 * The SHADOW is not here: it belongs to the OPEN drawer alone (see
 * `translateClass`). A closed panel is only translated off-screen, and a wide
 * ambient shadow reaches back past its own edge — so every phone screen wore a
 * grey smear down the edge the drawer was parked behind.
 */
const PANEL_CLASS =
  'max-sm:fixed max-sm:top-11 max-sm:right-0 max-sm:bottom-0 max-sm:z-50 max-sm:transition-transform max-sm:duration-200';

/**
 * The off-canvas phone drawer: a tap-outside backdrop plus a fixed panel that
 * slides in from the right edge, pinned under the title bar. It hosts the
 * run-details panel (`chats/Chats.tsx`'s `PanelHost`) — the one phone surface
 * that is a panel over a page rather than a page of its own.
 *
 * The PANEL's own look — border, background, width — is the caller's
 * business: this component owns only the drawer MECHANICS (the backdrop, the
 * fixed positioning, the slide transform), never a surface's styling.
 *
 * The panel is a plain `div`, never a landmark `aside`: the run-details panel
 * inside it renders its OWN labelled `aside`, and an unlabelled complementary
 * landmark around a labelled one is two regions where a screen reader should
 * find one.
 */
export function MobileDrawer({
  open,
  onClose,
  className,
  children,
}: {
  open: boolean;
  /** Fired by a tap on the backdrop — never by the panel itself. */
  onClose: () => void;
  /** The panel's own look, merged AFTER the drawer mechanics above. */
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const translateClass = open
    ? 'max-sm:translate-x-0 max-sm:shadow-panel-lg'
    : 'max-sm:translate-x-full';

  return (
    <>
      {open ? (
        <div aria-hidden="true" onClick={onClose} className={BACKDROP_CLASS} />
      ) : null}
      <div className={cn(PANEL_CLASS, translateClass, className)}>
        {children}
      </div>
    </>
  );
}
