import { Check } from 'lucide-react';
import * as React from 'react';

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
  disabled?: boolean;
  /**
   * An action rather than a choice — rendered without a checkmark column and
   * separated from the choices above it ("Choose folder…").
   */
  action?: boolean;
}

/** A titled block of rows ("Recents", "Agents", "Workflows"). */
export interface MenuGroup {
  label?: string;
  items: MenuItem[];
}

const flatten = (groups: MenuGroup[]): MenuItem[] =>
  groups.flatMap((group) => group.items).filter((item) => !item.disabled);

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
}): React.JSX.Element | null {
  const [query, setQuery] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);

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

  let index = -1;
  return (
    <div
      ref={panelRef}
      role="listbox"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        // No vertical padding: a row's highlight runs to the panel edge, where
        // `overflow-hidden` lets the corner radius clip it. Padding would leave
        // a bare strip above the first row and below the last.
        'absolute z-50 min-w-56 max-w-96 overflow-hidden rounded-xl border border-border bg-popover shadow-panel-md',
        side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        align === 'start' ? 'left-0' : 'right-0',
      )}>
      {searchPlaceholder !== undefined ? (
        <div className="border-b border-border px-3 py-1">
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
      <div className="max-h-80 overflow-y-auto">
        {selectable.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            {emptyLabel}
          </p>
        ) : (
          visible.map((group, groupIndex) => (
            <div
              key={group.label ?? `group-${groupIndex}`}
              className={cn(groupIndex > 0 && 'border-t border-border')}>
              {group.label !== undefined ? (
                <p className="px-3 pb-0.5 pt-1.5 text-xs font-medium text-muted-foreground">
                  {group.label}
                </p>
              ) : null}
              {group.items.map((item) => {
                index += 1;
                const active = index === highlight;
                const selected = !item.action && item.value === value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="option"
                    title={item.title}
                    aria-selected={selected}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground',
                      '[&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground',
                      active && 'bg-accent text-accent-foreground',
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
                      <Check className="size-4 shrink-0 text-muted-foreground" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
