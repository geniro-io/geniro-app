import * as React from 'react';

import { Menu, type MenuGroup } from './menu';

/** Where a context menu was raised, in viewport coordinates. */
export interface ContextMenuPoint {
  x: number;
  y: number;
}

/**
 * The app's RIGHT-CLICK menu, opened at the pointer rather than under a
 * trigger.
 *
 * It is `Menu` with a one-pixel anchor parked at the cursor, and that is the
 * whole implementation: the panel, the rows, the icons, the destructive tone,
 * the keyboard navigation, the outside-click guard, the viewport flipping and
 * the height clamp are all the primitive's, so a context menu and a dropdown
 * cannot drift into two looks. What a point anchor buys over `anchor="viewport"`
 * on a real trigger is only that the panel opens where the user clicked instead
 * of under the whole row, which on a 86px sidebar row is the difference between
 * a menu beside the pointer and one a centimetre below it.
 *
 * **It does not replace `main/context-menu.ts`.** That one is Electron's own
 * `context-menu` on the WebContents, and it exists because a packaged app has
 * no menu at all — it answers a right-click on an IMAGE or in a TEXT FIELD with
 * the platform's copy/paste roles, and an empty template on anything else, which
 * is precisely the case this covers. A caller here must `preventDefault()` the
 * DOM event, which is what stops Chromium raising the native request at all, so
 * the two can never both appear.
 */
export function ContextMenu({
  point,
  groups,
  onSelect,
  onClose,
  className,
}: {
  /** Null closes it — the caller owns the state; see {@link useContextMenu}. */
  point: ContextMenuPoint | null;
  groups: MenuGroup[];
  onSelect: (value: string) => void;
  onClose: () => void;
  className?: string;
}): React.JSX.Element | null {
  const anchorRef = React.useRef<HTMLSpanElement | null>(null);
  if (point === null) {
    return null;
  }
  return (
    <>
      {/*
        The anchor is DOM rather than a synthetic rect because `Menu` measures a
        real element (`getBoundingClientRect`) and re-measures it on scroll and
        resize. It is committed in the same pass as the menu beside it, so its
        ref is populated before any layout effect runs and the first measurement
        is the right one.

        `fixed` at the cursor, and one pixel: the panel is placed a fixed gap
        below the anchor's box, so a zero-height one would sit flush against the
        pointer and a large one would push it away from where the user clicked.
      */}
      <span
        ref={anchorRef}
        aria-hidden="true"
        data-slot="context-menu-anchor"
        className="pointer-events-none fixed size-px"
        style={{ left: point.x, top: point.y }}
      />
      <Menu
        open
        groups={groups}
        anchor="viewport"
        triggerRef={anchorRef}
        side="bottom"
        align="start"
        onSelect={onSelect}
        onClose={onClose}
        className={className}
      />
    </>
  );
}

/**
 * The three lines every caller of {@link ContextMenu} needs: open it where the
 * pointer is, and close it again.
 *
 * `onContextMenu` PREVENTS the default, which is not merely tidiness — it is
 * what suppresses Electron's own menu, so a right-click on a row carrying
 * selected text cannot raise both this panel and the platform's copy menu.
 */
export function useContextMenu(): {
  point: ContextMenuPoint | null;
  onContextMenu: (event: React.MouseEvent) => void;
  close: () => void;
} {
  const [point, setPoint] = React.useState<ContextMenuPoint | null>(null);
  const onContextMenu = React.useCallback((event: React.MouseEvent): void => {
    event.preventDefault();
    setPoint({ x: event.clientX, y: event.clientY });
  }, []);
  const close = React.useCallback(() => setPoint(null), []);
  return { point, onContextMenu, close };
}
