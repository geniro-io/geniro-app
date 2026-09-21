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
 */
const PANEL_CLASS =
  'max-sm:fixed max-sm:top-11 max-sm:bottom-0 max-sm:z-50 max-sm:shadow-panel-lg max-sm:transition-transform max-sm:duration-200';

/**
 * The off-canvas phone drawer: a tap-outside backdrop plus a fixed, sliding
 * panel pinned under the title bar. The nav rail (`App.tsx`) and the chat
 * list (`chats/Chats.tsx`) each hand-rolled an identical backdrop-plus-panel
 * before this existed — the `top-11`/`z-40`/`z-50` facts above restated in
 * both files, free to drift apart the moment either was edited alone.
 *
 * The PANEL's own look — border, background, width, and whether it is a
 * plain `div` or a landmark `aside` — is the caller's business: this
 * component owns only the drawer MECHANICS (the backdrop, the fixed
 * positioning, the slide transform), never a surface's styling.
 */
export function MobileDrawer({
  open,
  onClose,
  side = 'left',
  as = 'div',
  className,
  children,
}: {
  open: boolean;
  /** Fired by a tap on the backdrop — never by the panel itself. */
  onClose: () => void;
  /** Which edge the panel slides from and pins to. Both call sites today are `left`. */
  side?: 'left' | 'right';
  /** The panel's element — `aside` for a landmark region, `div` otherwise. */
  as?: 'div' | 'aside';
  /** The panel's own look, merged AFTER the drawer mechanics above. */
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const Panel = as;
  const edgeClass = side === 'left' ? 'max-sm:left-0' : 'max-sm:right-0';
  const translateClass = open
    ? 'max-sm:translate-x-0'
    : side === 'left'
      ? 'max-sm:-translate-x-full'
      : 'max-sm:translate-x-full';

  return (
    <>
      {open ? (
        <div aria-hidden="true" onClick={onClose} className={BACKDROP_CLASS} />
      ) : null}
      <Panel className={cn(PANEL_CLASS, edgeClass, translateClass, className)}>
        {children}
      </Panel>
    </>
  );
}
