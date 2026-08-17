import { Check } from 'lucide-react';
import * as React from 'react';

import { popoverSurface } from './popover';
import { cn } from './utils';

/** One selectable row. `value` is what `onSelect` reports back. */
export interface MenuItem {
  value: string;
  label: string;
  /** Leading glyph — a folder, a branch, a workflow icon. */
  icon?: React.ReactNode;
  /** Right-aligned muted text (a shortcut, a qualifier). */
  hint?: string;
  /** Native tooltip — where `label` is an abbreviation of something longer. */
  title?: string;
  /**
   * An action rather than a choice — rendered without a checkmark column and
   * separated from the choices above it ("Choose folder…").
   */
  action?: boolean;
  /**
   * A row whose action is destructive, toned to say so.
   *
   * A tone rather than a caller-supplied class: "the dangerous row" is one
   * decision, and every menu that has one should read the same.
   */
  tone?: 'destructive';
  /**
   * Visible but not choosable — an option that exists and cannot be taken.
   *
   * Shown rather than dropped so the absence is explained instead of leaving
   * the user to wonder where an entry went; pair it with {@link hint} carrying
   * the reason ("not installed"). Blocked in BOTH ways a row can be taken: the
   * native `disabled` stops the pointer, and `commit` refuses so a keyboard
   * Enter on a highlighted row cannot slip past it.
   */
  disabled?: boolean;
}

/** A titled block of rows ("Recents", "Agents", "Workflows"). */
export interface MenuGroup {
  label?: string;
  items: MenuItem[];
}

/**
 * The rows in render order. The highlight is an index into THIS list, and the
 * rows below are numbered by the same arithmetic — keep the two derived from
 * one flattening so a keyboard highlight and a hovered row can never mean
 * different things.
 */
const flatten = (groups: MenuGroup[]): MenuItem[] =>
  groups.flatMap((group) => group.items);

/** Breathing room kept between a shortened panel and the window edge. */
const VIEWPORT_MARGIN = 8;

/**
 * The shortest a panel is shortened to, however little room there is.
 *
 * Roughly three rows: below that the menu stops being usable as a list, and an
 * overhanging panel whose rows scroll is the better failure of the two.
 */
const MIN_MENU_HEIGHT = 120;

/**
 * The app's dropdown: a token-styled popover list, built from scratch because
 * the native `<select>` menu is drawn by the OS and can render none of what
 * these menus need — section headers, leading icons, a checkmark on the current
 * value, a search field, or an action row. It is also the reason a dropdown can
 * be screenshotted and asserted on at all; the OS menu lives outside the DOM.
 *
 * Positioning is `absolute` against the trigger's wrapper rather than a portal:
 * every menu in this app hangs off a composer chip or an inspector field, both
 * inside normal scroll containers, so there is no clipping to escape.
 */
export function Menu({
  open,
  groups,
  value,
  searchPlaceholder,
  emptyLabel = 'No matches',
  align = 'start',
  side = 'top',
  onSelect,
  onClose,
  labelledBy,
  className,
}: {
  open: boolean;
  groups: MenuGroup[];
  /** The current value — gets the checkmark. */
  value?: string;
  /** Provided = the menu gets a filter field focused on open. */
  searchPlaceholder?: string;
  emptyLabel?: string;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  onSelect: (value: string) => void;
  onClose: () => void;
  labelledBy?: string;
  /**
   * Panel overrides — in practice its WIDTH, for a menu that opens inside a
   * container narrower than the default.
   *
   * The default sizing suits the composer, which has the whole window to grow
   * into. The chat sidebar does not: measured at 260px, an options menu sized
   * by its longest row came out 257px wide inside a 235px slot and was clipped
   * by the list's own scroll container. A caller that knows its container caps
   * the panel (`min-w-0 w-52`) and lets the rows truncate, which they already
   * do.
   */
  className?: string;
}): React.JSX.Element | null {
  const [query, setQuery] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  /**
   * Set when a left-aligned panel would run off the right of the window, which
   * a chip near the composer's edge — or any chip inside the overflow popover,
   * itself pinned right — otherwise does. Measured rather than guessed: the
   * panel's width depends on its longest row.
   */
  const [flipped, setFlipped] = React.useState(false);
  /**
   * The panel's own height cap, when its full height does not fit in the window.
   *
   * The horizontal axis has been measured since the chip row gained an overflow
   * popover; the vertical one never was, and `max-h-80` on the row list is a cap
   * on the LIST rather than a promise that the panel fits anywhere. So a long
   * list — the branch picker, which has as many rows as the repo has branches —
   * simply extended past the top of the window with nothing to stop it.
   * Reproduced at 900×420 with fourteen branches: a 341px panel sat at
   * `top: -326`, leaving 14 of its pixels on screen ("sometimes popover with
   * branch is cut").
   *
   * Null means "fits, cap nothing" — which is every menu the report is not
   * about, so the common case keeps its natural size.
   */
  const [maxHeight, setMaxHeight] = React.useState<number | null>(null);

  React.useLayoutEffect(() => {
    if (!open) {
      setFlipped(false);
      setMaxHeight(null);
      return;
    }
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      setFlipped(true);
    }
    // The panel grows AWAY from the trigger — upward from a fixed bottom edge
    // for `side='top'`, downward for `bottom` — so the edge it can run past is
    // decided by `side`, and shortening it always pulls the offending end back.
    const overflow =
      side === 'top' ? -rect.top : rect.bottom - window.innerHeight;
    if (overflow > 0) {
      // Floored rather than allowed to collapse: a menu shortened to the two
      // rows that happen to fit is a worse answer than one that overhangs
      // slightly and scrolls, and the list inside already scrolls. Measured
      // against the app's own minimum window (640px tall), the floor is only
      // ever reached by a trigger sitting near the top of the window.
      setMaxHeight(
        Math.max(MIN_MENU_HEIGHT, rect.height - overflow - VIEWPORT_MARGIN),
      );
    }
  }, [open, side]);

  // A fresh open is a fresh search — a stale filter would hide the very rows
  // the user just reopened the menu to see. Focus moves into the menu either
  // way: to the search field when there is one, else to the panel itself, or
  // the arrow keys would have nothing listening.
  React.useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      (searchRef.current ?? panelRef.current)?.focus();
    }
  }, [open]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return groups;
    }
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            // An action row is a command, not a match candidate; filtering it
            // out would strand the user with no way to reach what they were
            // searching for.
            item.action ||
            item.label.toLowerCase().includes(needle) ||
            // `title` where set holds the UNABBREVIATED value — a folder row's
            // label is elided at the front, so without this a search for
            // anything in the elided head would find nothing.
            (item.title?.toLowerCase().includes(needle) ?? false),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, query]);

  const selectable = React.useMemo(() => flatten(visible), [visible]);

  // Keep the highlight on a row that still exists as the filter narrows.
  React.useEffect(() => {
    setHighlight((current) =>
      Math.min(current, Math.max(selectable.length - 1, 0)),
    );
  }, [selectable.length]);

  // Close on any click that lands outside the panel AND outside the trigger —
  // the trigger owns its own toggle, so swallowing its clicks here would make
  // a second press reopen a menu the toggle had just closed.
  React.useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent): void => {
      const panel = panelRef.current;
      const target = event.target as Node | null;
      if (panel && target && !panel.contains(target)) {
        const trigger = panel.parentElement?.querySelector(
          '[data-menu-trigger]',
        );
        if (!trigger?.contains(target)) {
          onClose();
        }
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const commit = (item: MenuItem): void => {
    if (item.disabled) {
      return;
    }
    onSelect(item.value);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((current) => {
        if (selectable.length === 0) {
          return 0;
        }
        return (current + step + selectable.length) % selectable.length;
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = selectable[highlight];
      if (item) {
        commit(item);
      }
    }
  };

  return (
    <div
      ref={panelRef}
      role="listbox"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // The measured cap, when there was not room for the panel's full height.
      // Inline because it is a MEASUREMENT — see `maxHeight`.
      style={maxHeight === null ? undefined : { maxHeight }}
      className={cn(
        // The shared floating surface, plus this panel's own sizing. No
        // vertical padding: a row's highlight runs to the panel edge, where
        // `overflow-hidden` lets the corner radius clip it. Padding would leave
        // a bare strip above the first row and below the last.
        popoverSurface,
        // `flex flex-col` is what makes the cap above reach the row list: the
        // search field keeps its height and the list takes what is left. As a
        // plain block the capped panel would simply clip its own rows, hiding
        // them with no way to scroll to them.
        'flex min-w-56 max-w-96 flex-col overflow-hidden',
        side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        align === 'start' && !flipped ? 'left-0' : 'right-0',
        className,
      )}>
      {searchPlaceholder !== undefined ? (
        <div className="shrink-0 border-b border-border px-3 py-1.5">
          <input
            ref={searchRef}
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="w-full bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
          />
        </div>
      ) : null}
      {/* `min-h-0` is what lets a flex CHILD shrink below its content height —
          without it the list keeps its full size and the capped panel clips
          instead of scrolling. `max-h-80` stays as the cap for a panel that
          fits: a menu is a picker, not a page. */}
      <div className="max-h-80 min-h-0 flex-1 overflow-y-auto p-1">
        {selectable.length === 0 ? (
          <p className="px-2.5 py-2 text-sm text-muted-foreground">
            {emptyLabel}
          </p>
        ) : (
          visible.map((group, groupIndex) => {
            // Where this group's first row sits in the flat list the highlight
            // indexes into. Derived per render from the map arguments rather
            // than carried in a counter across the whole tree: a `let` in the
            // component body is ONE binding shared by every row's handlers, so
            // each `onMouseEnter` closure would read its final value and hover
            // would highlight the last row no matter which one the cursor was
            // over.
            const offset = visible
              .slice(0, groupIndex)
              .reduce((total, previous) => total + previous.items.length, 0);
            return (
              <div
                key={group.label ?? `group-${groupIndex}`}
                // A HAIRLINE between blocks rather than a full border on the
                // block itself: with the rows inset, an edge-to-edge rule cut
                // across the padding and made the panel look like two stacked
                // boxes.
                className={cn(
                  groupIndex > 0 && 'mt-1 border-t border-border/70 pt-1',
                )}>
                {group.label !== undefined ? (
                  <p className="px-2.5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </p>
                ) : null}
                {group.items.map((item, itemIndex) => {
                  const index = offset + itemIndex;
                  const active = index === highlight;
                  const selected = !item.action && item.value === value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      role="option"
                      title={item.title}
                      aria-selected={selected}
                      disabled={item.disabled}
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors',
                        '[&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground',
                        item.tone === 'destructive' &&
                          'text-destructive [&>svg]:text-destructive',
                        active &&
                          !item.disabled &&
                          (item.tone === 'destructive'
                            ? 'bg-destructive/10'
                            : 'bg-accent text-accent-foreground'),
                        item.disabled &&
                          'cursor-not-allowed text-muted-foreground opacity-60',
                      )}
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => commit(item)}>
                      {item.icon}
                      <span className="min-w-0 flex-1 truncate">
                        {item.label}
                      </span>
                      {item.hint !== undefined ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {item.hint}
                        </span>
                      ) : null}
                      {selected ? (
                        <Check className="size-4 shrink-0 text-primary" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
