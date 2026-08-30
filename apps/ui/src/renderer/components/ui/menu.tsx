import { Check, ChevronRight } from 'lucide-react';
import * as React from 'react';

import type { ProfileColor } from '../../../shared/contracts';
import { PALETTE_BORDER_CLASS } from '../palette';
import { popoverSurface } from './popover';
import { cn } from './utils';

/** One selectable row. `value` is what `onSelect` reports back. */
export interface MenuItem {
  value: string;
  label: string;
  /** Leading glyph — a folder, a branch, a workflow icon. */
  icon?: React.ReactNode;
  /**
   * A colour this row carries as a LEFT BORDER, from the app's one palette.
   *
   * A border rather than another glyph, and asked for in those words ("там
   * должен быть просто левый бордер вот этого же цвета"). The row already
   * leads with an icon that says what KIND of thing it is, and a second mark
   * beside it would compete with that; an edge stripe is read by position and
   * costs the label no width. It is also how the sidebar already draws a
   * group's colour — a rail down the edge of the rows it owns — so a named
   * agent configuration and a chat group wear their colour the same way.
   *
   * Absent leaves the row exactly as it was: most rows in most menus have no
   * colour, and a transparent placeholder border would shift every label by
   * its width for the sake of the few that do.
   */
  accent?: ProfileColor;
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
   * Whether this row carries the checkmark, overriding the menu's own
   * `item.value === value` rule.
   *
   * A menu normally holds ONE choice, so the selected row is the one matching
   * the menu's value. It exists for the menu that holds SEVERAL independent
   * choices at once — a model plus each of that model's own settings, in one
   * panel (`chats/model-settings-select.tsx`) — where a single value can only
   * ever check one of them and every other block would open showing nothing
   * chosen. Left undefined, the old rule applies unchanged.
   */
  checked?: boolean;
  /**
   * The rows this one OPENS instead of committing — a second level.
   *
   * A row carrying one is a heading with a value on it: the label names the
   * choice, {@link hint} states where it currently stands, and a chevron says
   * there is more behind it. Nothing about it is a checkbox, so it never takes
   * the checkmark.
   *
   * It exists because one panel could not hold a model AND everything that
   * model can be run with: measured on cursor's `claude-opus-5`, five blocks
   * plus thirty-four model rows is a scroller nobody reads to the end of, and
   * a flat list is what got reported ("сейчас у нас один огромный большой
   * список. У нас должно быть двух-уровневое меню"), with Cursor's own picker
   * as the reference — one compact list of axes, each opening its values.
   */
  submenu?: MenuGroup[];
  /** Gives {@link submenu} a filter field — for a level with many rows. */
  submenuSearchPlaceholder?: string;
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
  /**
   * A sentence about this block, in ordinary prose — why it is short, or why
   * the row below is the only one.
   *
   * Distinct from {@link MenuGroup.label}, which is an 11px uppercase
   * micro-label naming a block ("RECENTS"); a sentence set in that treatment
   * outweighs every row beneath it. This wraps, is muted, and reads as an
   * aside.
   *
   * It exists because a control that offers ONE row cannot explain itself from
   * the trigger: the explanation lived in the chip's hover `title`, and nobody
   * hovers a control they have already opened and decided is broken. Put the
   * reason where the question is asked.
   */
  note?: string;
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

/** Gap between a viewport-anchored panel and the trigger it hangs off. */
const TRIGGER_GAP = 6;

/**
 * What menus in this subtree are positioned against — see {@link Menu}'s
 * `anchor`. A container that CLIPS (`Dialog`, whose body scrolls) provides
 * `viewport`, so every picker inside it escapes without each one being passed a
 * prop through the chip that renders it. Defaults to `ancestor`, which is what
 * a menu in open layout wants.
 */
export const MenuAnchorContext = React.createContext<'ancestor' | 'viewport'>(
  'ancestor',
);

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
 * Positioning is `absolute` against the trigger's wrapper by default; a menu
 * inside a container that CLIPS takes `anchor="viewport"` to escape it, the
 * same mechanism and for the same reason as `Popover`'s.
 */
export function Menu({
  open,
  groups,
  value,
  searchPlaceholder,
  emptyLabel = 'No matches',
  align = 'start',
  side = 'top',
  anchor,
  triggerRef,
  onSelect,
  onClose,
  onCloseSubmenu,
  labelledBy,
  id,
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
  /**
   * Where the panel sits relative to its trigger. `right` is the SUBMENU
   * placement — beside the row that opened it rather than above or below —
   * and is floating-only, since a second level inside a scrolling list has to
   * escape it.
   */
  side?: 'top' | 'bottom' | 'right';
  /**
   * What the panel is positioned against. Omitted, it takes
   * {@link MenuAnchorContext} — so a clipping container decides for every menu
   * inside it and callers pass nothing.
   *
   * `viewport` measures the trigger and places the panel `fixed`, the ONLY way
   * out of a clipping ancestor: `overflow-x: visible` cannot be restored on a
   * box that scrolls vertically, since CSS forces both axes non-visible
   * together. Measured in a dialog whose branch picker opened upward inside
   * `Dialog`'s `overflow-y-auto` body — the panel's top rows were cut at the
   * body's edge ("the branch list popover is cut").
   *
   * Requires a `triggerRef`; without one there is nothing to measure and the
   * panel falls back to `ancestor`.
   */
  anchor?: 'ancestor' | 'viewport';
  /** The control the panel hangs off — required by `anchor="viewport"`. */
  triggerRef?: React.RefObject<HTMLElement | null>;
  onSelect: (value: string) => void;
  onClose: () => void;
  /**
   * Dismiss just THIS level, leaving the one that opened it standing.
   *
   * Only a second level is given one, and it is what `ArrowLeft` runs: without
   * it the sole way out of a submenu is `Escape`, which closes the whole picker
   * — so a keyboard user who opened the wrong axis had to reopen the panel and
   * navigate back to where they were.
   */
  onCloseSubmenu?: () => void;
  labelledBy?: string;
  /** Ties this panel to the row that opened it, via that row's `aria-controls`. */
  id?: string;
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
  /**
   * The value of the row whose second level is open, or null.
   *
   * The row that opened it is remembered as a plain ref rather than one ref per
   * row: only one submenu is open at a time, and the child needs its trigger's
   * rect for placement. Set from the event's own `currentTarget` at the moment
   * of opening, so it is already there when the child mounts.
   */
  const [submenuFor, setSubmenuFor] = React.useState<string | null>(null);
  const submenuTriggerRef = React.useRef<HTMLElement | null>(null);
  /** What the open row's `aria-controls` points at — one panel at a time. */
  const submenuPanelId = React.useId();
  /**
   * The `fixed` box for `anchor="viewport"`, measured off the trigger — null in
   * ancestor mode, where the placement is a class rather than a measurement.
   */
  const [box, setBox] = React.useState<React.CSSProperties | null>(null);

  const contextAnchor = React.useContext(MenuAnchorContext);
  // A viewport anchor with nothing to measure cannot be honoured, so it degrades
  // to the ancestor placement rather than rendering at the window's origin.
  const floating =
    (anchor ?? contextAnchor) === 'viewport' && triggerRef !== undefined;

  // Measured on open, and re-measured while open on scroll or resize: a fixed
  // panel does not travel with its trigger, so without this it sits where the
  // trigger USED to be. `capture`, because the scroll happens on an inner
  // container and scroll events do not bubble.
  React.useLayoutEffect(() => {
    if (!open || !floating) {
      setBox(null);
      return;
    }
    const measure = (): void => {
      const trigger = triggerRef?.current;
      if (!trigger) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      setBox(
        side === 'right'
          ? {
              position: 'fixed',
              // Aligned with the row's own top edge, nudged by the panel's
              // padding so the first child row lines up with its parent.
              top: Math.max(VIEWPORT_MARGIN, rect.top - 5),
              left: rect.right + TRIGGER_GAP,
            }
          : {
              position: 'fixed',
              ...(side === 'top'
                ? { bottom: window.innerHeight - rect.top + TRIGGER_GAP }
                : { top: rect.bottom + TRIGGER_GAP }),
              ...(align === 'end'
                ? { right: window.innerWidth - rect.right }
                : { left: rect.left }),
            },
      );
    };
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, true);
    };
  }, [open, floating, side, align, triggerRef]);

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
    // A floating panel is placed in TWO commits — the effect above reads the
    // trigger and sets `box`, and only the render after that moves the panel —
    // so before `box` lands there is nothing here worth measuring: the panel is
    // still sitting where the ancestor classes put it. The horizontal
    // correction below survives that (it re-runs on `box` and settles), but the
    // HEIGHT clamp does not, because nothing ever lowers `maxHeight` again
    // until the menu closes. A first-pass measurement therefore froze a cap
    // taken at the wrong position, for good.
    //
    // That is what "popover is cut" turned out to be, measured in the running
    // app on the composer's Profile submenu: an eight-row panel came out
    // `maxHeight: 120px` — the FLOOR — while sitting at `top: 715` in a 900px
    // window, where it had over 170px of room and needed no cap at all. The
    // clamp had fired against the unplaced first commit and stuck.
    if (floating && box === null) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      // A floating panel is placed by an inline offset, so it is corrected by
      // one — pulled back by exactly its overflow. The class-based flip below
      // only reaches the ancestor mode, where `right-0` is a real placement.
      if (floating) {
        setBox((current) => {
          if (current === null || current.left === undefined) {
            return current;
          }
          const corrected = Math.max(
            VIEWPORT_MARGIN,
            rect.left - (rect.right - window.innerWidth) - VIEWPORT_MARGIN,
          );
          // The SAME object when nothing moves, which is what bounds this now
          // that the effect re-runs on `box`: React bails out of an identical
          // reference, so a panel that cannot be pulled back any further (a
          // measurement that does not change with the offset) settles instead
          // of correcting itself for ever.
          return corrected === current.left
            ? current
            : { ...current, left: corrected };
        });
      } else {
        setFlipped(true);
      }
    }
    // A SUBMENU is the one placement that could only ever be SHORTENED, and
    // shortening is the wrong first answer for it. `side='right'` pins the
    // panel's top to the row that opened it and grows down, so a row low in the
    // window put the panel's tail off the bottom — REPORTED as "popover is
    // cut", on the composer's Profile submenu, whose parent opens upward from a
    // control that sits at the foot of the screen. The height clamp below did
    // fire, but it is FLOORED at `MIN_MENU_HEIGHT` on purpose, so once the room
    // under the row falls below that floor the panel overhangs anyway — and the
    // rows past the edge are unreachable, since what scrolls is the list inside
    // a panel whose own box is off-screen.
    //
    // Moving it UP is the answer every other placement already has in some
    // form: the horizontal correction right above pulls a panel back from the
    // right edge, and `side='top'`/`'bottom'` flip. A submenu shifted up still
    // sits beside its row — which is all its placement ever promised — where a
    // shortened one silently drops choices.
    //
    // It RETURNS rather than falling through to the clamp, and that is not
    // tidiness: the clamp would otherwise read the un-shifted rect, set a
    // `maxHeight` for an overflow this shift is about to remove, and nothing
    // lowers `maxHeight` again until the menu closes. The effect re-runs on
    // `box`, so the moved panel is measured afresh on the next pass and the
    // clamp still catches whatever is left — which is the genuinely
    // taller-than-the-window case, and only that.
    if (side === 'right' && floating && typeof box?.top === 'number') {
      const overhang = rect.bottom - (window.innerHeight - VIEWPORT_MARGIN);
      const corrected = Math.max(VIEWPORT_MARGIN, box.top - overhang);
      if (overhang > 0 && corrected !== box.top) {
        setBox({ ...box, top: corrected });
        return;
      }
    }
    // The panel grows AWAY from the trigger — upward from a fixed bottom edge
    // for `side='top'`, downward for `bottom` and `right` — so the edge it can
    // run past is decided by `side`, and shortening it always pulls the
    // offending end back.
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
    // `box` is in here, and without it this whole effect measured the wrong
    // panel. A floating menu is placed in TWO commits — the effect above reads
    // the trigger and sets `box`, and only the render after that moves the
    // panel — so on the first pass this measured it where the ancestor
    // placement had put it, found no overflow, and never looked again.
    // Measured at 1000×640 on the landing card's branch picker, which is what
    // sent it off the right edge (`right: 1036` in a 1000px window) the moment
    // that card started anchoring to the viewport. Re-running on `box` also
    // keeps the correction true through the scroll and resize re-measurements,
    // which reset the offset this may have pulled back; it settles because a
    // corrected panel overflows nothing, so the next pass changes nothing.
  }, [open, side, floating, box]);

  // A fresh open is a fresh search — a stale filter would hide the very rows
  // the user just reopened the menu to see. Focus moves into the menu either
  // way: to the search field when there is one, else to the panel itself, or
  // the arrow keys would have nothing listening.
  React.useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      (searchRef.current ?? panelRef.current)?.focus();
    } else {
      setSubmenuFor(null);
    }
  }, [open]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      // An EMPTY group is dropped here exactly as the search branch below drops
      // one it has filtered empty, and for a reason the search branch never had
      // to state: a group renders as a `<div>` whose only content may be its
      // rows, and the group AFTER it draws the hairline that separates blocks.
      // So a caller passing a conditionally-empty group got a blank band with a
      // rule under it — reported against the context-window chip on a cursor
      // model that offers one fixed size, where the sizes group is empty and
      // the `model default` row sits alone beneath an empty box. It reads as a
      // menu that failed to load, which is exactly what it was taken for.
      //
      // Callers compose groups from data, so "this block has nothing in it" is
      // ordinary rather than a caller mistake; the arithmetic above is already
      // written against `visible` rather than `groups`, so nothing downstream
      // notices.
      return groups.filter((group) => group.items.length > 0);
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
        // The caller's own ref when it gave one — a floating panel may not sit
        // beside its trigger in the DOM, and `parentElement` is a guess that
        // finds the first chip of whatever wrapper it lands in.
        const trigger =
          triggerRef?.current ??
          panel.parentElement?.querySelector('[data-menu-trigger]');
        if (!trigger?.contains(target)) {
          onClose();
        }
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, onClose, triggerRef]);

  if (!open) {
    return null;
  }

  const commit = (item: MenuItem): void => {
    if (item.disabled) {
      return;
    }
    // A row with a second level OPENS rather than chooses — it has no value of
    // its own to commit.
    if (item.submenu) {
      setSubmenuFor(item.value);
      return;
    }
    onSelect(item.value);
    onClose();
  };

  /** The row whose second level is open, looked up across every group. */
  const submenuItem =
    submenuFor === null
      ? null
      : (groups
          .flatMap((group) => group.items)
          .find((item) => item.value === submenuFor && item.submenu) ?? null);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    /**
     * Consume this key here and nowhere above.
     *
     * Scoped to the keys the panel actually handles, never the whole event
     * stream: the second level renders INSIDE the first, so an arrow press that
     * bubbled moved BOTH highlights — but this panel is also inside whatever
     * opened it, and stopping every key there costs the ancestors their own.
     * `Dialog` traps Tab on its card and closes on Escape from a `document`
     * listener, and `App` binds ⌥⌘L on `window`; React's `stopPropagation`
     * stops the NATIVE event at its root container, which is below all three.
     * So a blanket stop let Tab escape the modal focus trap for as long as any
     * picker was open.
     */
    const consume = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    // Back out of this level, keeping the one that opened it — the second level
    // is the only one placed to the `right`, so that placement is what says
    // there is a level to go back to.
    //
    // Not while the caret is in the search field: Left and Right are caret keys
    // there, and the one submenu that HAS a field is the model list, whose 34
    // rows are what the field exists for — so backing out on ArrowLeft would
    // discard a half-typed query instead of moving the caret one character.
    if (
      event.key === 'ArrowLeft' &&
      onCloseSubmenu &&
      !(event.target instanceof HTMLInputElement)
    ) {
      consume();
      onCloseSubmenu();
      return;
    }
    if (event.key === 'Escape') {
      consume();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      consume();
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
      consume();
      const item = selectable[highlight];
      if (item) {
        commit(item);
      }
    }
  };

  return (
    <div
      ref={panelRef}
      id={id}
      // The panel and its listbox are two elements (see the rows container
      // below), so what carries the surface and the placement needs a hook of
      // its own — `[role="listbox"]` now finds the rows, which have neither.
      data-slot="menu-panel"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // Both are MEASUREMENTS, so both are inline: the height cap when the
      // panel did not fit, and the floating box when it is escaping a clip.
      style={{
        ...box,
        ...(maxHeight === null ? undefined : { maxHeight }),
      }}
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
        // `w-max` is what makes the panel size to its LONGEST ROW; the two
        // bounds either side of it are the floor and the ceiling, not the
        // width. Without it the panel took its shrink-to-fit width and landed
        // exactly on `min-w-56` whatever its rows said — the intrinsic
        // contribution never reaching it through the row list — so every label
        // truncated inside a panel with room to spare. MEASURED in the running
        // app at this repo's 15px root: the composer's model-settings panel
        // 210px wide with `Approval` clipped to `Appro…` (55px of text in a
        // 50px box), against 216px and nothing clipped once the panel asks for
        // its content. REPORTED as "оно должно влезать".
        //
        // `max-w-96` still caps it and the rows still carry `min-w-0 truncate`,
        // so a genuinely long label truncates exactly as before — and a caller
        // that pins a width for a narrow container (`min-w-0 w-52`, the chat
        // sidebar) still wins, its class landing after this one.
        'flex w-max min-w-56 max-w-96 flex-col overflow-hidden',
        // The placement utilities are `absolute` offsets and belong to the
        // ancestor mode alone; the floating box above carries its own.
        box === null &&
          (side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'),
        box === null && (align === 'start' && !flipped ? 'left-0' : 'right-0'),
        className,
      )}>
      {searchPlaceholder !== undefined ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-1.5">
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
      {/* The LISTBOX is this rows container, not the panel around it: a
          `listbox` may own only `option`/`group` children, and the panel also
          holds the search field and — the case that broke it — the second
          level, itself a listbox. Nested, a screen reader computes the wrong
          set size for the outer list and may not expose the inner one at all.
          `min-h-0` is what lets a flex CHILD shrink below its content height —
          without it the list keeps its full size and the capped panel clips
          instead of scrolling. `max-h-80` stays as the cap for a panel that
          fits: a menu is a picker, not a page. */}
      <div
        role="listbox"
        aria-labelledby={labelledBy}
        className="max-h-80 min-h-0 flex-1 overflow-y-auto p-1">
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
                data-slot="menu-group"
                // A HAIRLINE between blocks rather than a full border on the
                // block itself: with the rows inset, an edge-to-edge rule cut
                // across the padding and made the panel look like two stacked
                // boxes.
                className={cn(
                  // Faint, to match the panel's own softened edge: at /70 the
                  // rule was heavier than the border around it and cut a
                  // four-row menu into two stacked boxes.
                  groupIndex > 0 && 'mt-1 border-t border-border/45 pt-1',
                )}>
                {group.label !== undefined ? (
                  // A micro-label, not a banner. `tracking-wide` over 11px
                  // uppercase stretched "START FROM A CONFIGURATION" across the
                  // full width of a four-row menu, where it outweighed every
                  // row under it — the loudest thing on a surface whose whole
                  // job is the rows.
                  <p
                    data-slot="menu-group-heading"
                    className="px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.055em] text-muted-foreground">
                    {group.label}
                  </p>
                ) : null}
                {group.note !== undefined ? (
                  <p
                    data-slot="menu-group-note"
                    className="px-2.5 pb-1.5 pt-0.5 text-xs leading-snug text-muted-foreground">
                    {group.note}
                  </p>
                ) : null}
                {group.items.map((item, itemIndex) => {
                  const index = offset + itemIndex;
                  const active = index === highlight;
                  const selected =
                    item.checked ?? (!item.action && item.value === value);
                  return (
                    <button
                      key={item.value}
                      type="button"
                      role="option"
                      title={item.title}
                      // A row that OPENS a level is not a choice, so it carries
                      // no `aria-selected` — it advertises the panel behind it
                      // instead.
                      {...(item.submenu
                        ? {
                            'aria-haspopup': 'listbox' as const,
                            'aria-expanded': submenuFor === item.value,
                            ...(submenuFor === item.value
                              ? { 'aria-controls': submenuPanelId }
                              : {}),
                          }
                        : { 'aria-selected': selected })}
                      disabled={item.disabled}
                      className={cn(
                        // `rounded-lg`, which is the panel's own 12px radius
                        // less its 4px padding. At `rounded-md` the row's
                        // corners were tighter than the panel's, so a
                        // highlighted row sitting in the corner traced a second,
                        // disagreeing curve just inside the first.
                        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-foreground transition-colors',
                        // The colour rides a border on the row's own box, so
                        // it needs no element and no layout of its own. The
                        // left padding is reduced by exactly the border's width
                        // — otherwise a coloured row's label sits 2px right of
                        // its uncoloured neighbours', which on a list where
                        // only some rows are named reads as two indents.
                        item.accent !== undefined &&
                          cn(
                            'rounded-l-none border-l-2 pl-2',
                            PALETTE_BORDER_CLASS[item.accent],
                          ),
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
                      onMouseEnter={(event) => {
                        setHighlight(index);
                        // Hovering ANY row decides the second level: onto a row
                        // that has one it opens, onto one that has not it
                        // closes. Without the second half the panel would stay
                        // open over the rows the pointer moved on to.
                        if (item.submenu) {
                          submenuTriggerRef.current = event.currentTarget;
                          setSubmenuFor(item.value);
                        } else {
                          setSubmenuFor(null);
                        }
                      }}
                      onClick={(event) => {
                        submenuTriggerRef.current = event.currentTarget;
                        commit(item);
                      }}>
                      {item.icon}
                      <span className="min-w-0 flex-1 truncate">
                        {item.label}
                      </span>
                      {item.hint !== undefined ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {item.hint}
                        </span>
                      ) : null}
                      {item.submenu ? (
                        <ChevronRight
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      ) : selected ? (
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
      {/* The second level, rendered INSIDE this panel's DOM and OUTSIDE its
          listbox. Inside the panel because the outside-click guard above asks
          `panel.contains(target)`, so a click in the child must be a descendant
          or choosing a value would close the menu under itself; outside the
          listbox because that role admits no listbox child. `position: fixed`
          still escapes this panel's own scroller, so being a descendant costs
          no clipping. */}
      {submenuItem ? (
        <Menu
          open
          id={submenuPanelId}
          groups={submenuItem.submenu ?? []}
          searchPlaceholder={submenuItem.submenuSearchPlaceholder}
          side="right"
          anchor="viewport"
          triggerRef={submenuTriggerRef}
          // Straight through to the root's caller: a value chosen two levels
          // down is still the one value this menu was opened to pick.
          onSelect={onSelect}
          onClose={onClose}
          onCloseSubmenu={() => {
            setSubmenuFor(null);
            // The child held focus, so without this the arrow keys would have
            // nothing listening once it unmounts.
            panelRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
