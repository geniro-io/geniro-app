import { type AppView, NAV_ITEMS } from './nav-rail';
import { cn } from './ui/utils';

/**
 * The phone's main navigation: one icon per destination along the bottom edge,
 * the place a thumb already rests. It replaces the nav rail below `sm`, where
 * the rail has no room to stand beside the content.
 *
 * `sm:hidden` because at `sm` and wider the rail is on screen — and the
 * Electron window's own `minWidth` is 960, so this is drawn only in a phone
 * browser over the LAN gateway.
 *
 * Icons alone, each carrying its label as the accessible name and tooltip: five
 * labelled tabs do not fit a 360px phone without truncating, and the icons are
 * the rail's own, so they are the ones the user already knows.
 */
export function BottomTabBar({
  view,
  onNavigate,
  className,
}: {
  view: AppView;
  onNavigate: (view: AppView) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <nav
      aria-label="Main"
      data-slot="bottom-tab-bar"
      className={cn(
        'flex h-14 shrink-0 items-stretch border-t border-sidebar-border bg-sidebar sm:hidden',
        className,
      )}>
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = view === item.view;
        return (
          <button
            key={item.view}
            type="button"
            aria-label={item.label}
            title={item.label}
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate(item.view)}
            className={cn(
              'flex flex-1 items-center justify-center outline-none transition-colors focus-visible:bg-sidebar-accent',
              active
                ? 'text-sidebar-primary-strong'
                : 'text-sidebar-foreground/60 hover:text-sidebar-foreground',
            )}>
            <Icon
              aria-hidden="true"
              className="size-6"
              strokeWidth={active ? 2.25 : 1.75}
            />
          </button>
        );
      })}
    </nav>
  );
}
