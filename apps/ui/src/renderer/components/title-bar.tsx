import { TITLEBAR_CONTENT_INSET } from '../../shared/contracts';
import type { FooterUpdate } from '../updates/update-status';
import { UpdateControl } from './update-control';

/**
 * The window's title bar — ONE band across the whole window, above the columns.
 *
 * It used to be three: the rail's top row, the chat list's header and the
 * transcript's, each `h-11` and each ending at its own column's border. They
 * lined up, but two vertical borders ran straight through the strip, so what
 * the eye read was three column headings rather than a title bar — reported as
 * "this is crooked… our header should still look like a header", against
 * Cursor's, which is one continuous row with the window buttons, a title and a
 * few controls in it. Being ABOVE the columns is the whole fix: their borders
 * now start under it, so nothing crosses the band.
 *
 * It is also the shell's ONLY drag region. With the OS strip hidden a row moves
 * the window only if it says so, and spreading that across every column header
 * meant dragging the transcript's chip row moved the window — surprising once a
 * real title bar exists. `WindowDragStrip` still covers Onboarding and the
 * loading screen, which render before this does.
 *
 * The left inset is the window buttons' own measured footprint plus a gap
 * ({@link TITLEBAR_CONTENT_INSET}), which is the one number main and the
 * renderer must agree on — see `shared/contracts.ts`.
 *
 * The rail's collapse toggle deliberately does NOT live here. It was moved up
 * with everything else and moved straight back ("the little button that
 * collapses the menu is not where it should be — let's leave it in the menu
 * itself, right where it was"): it acts on the column beside it, not on the
 * window, so it belongs to that column. What is here is what is about the
 * WINDOW or the app as a whole.
 *
 * The debug-log trigger is gone from here too, and asked for by name. It was
 * the one control in the band a user never wants — an unlabelled `>_` beside
 * the version, opening a developer panel — while the two beside it report the
 * app's health and offer its update. ⌥⌘L still opens the drawer (`App.tsx`),
 * which is the whole of what the button did.
 *
 * The VERSION and the DAEMON-STATUS readout that stood beside it are gone as
 * well, in that order and both on report ("давай уберем полностью оттуда
 * версию и берём её в меню приложения", then "also remove connected status at
 * all"). The version is in the app menu now (`main/app-menu.ts`), where macOS
 * puts what an app IS. The status needed no new home: a daemon that is not
 * answering already raises `ConnectionBanner` across the top of every view,
 * with the reason and a retry — so the dot was a second, quieter telling of
 * something already said in full, and its only other state was a green pip
 * confirming that nothing was wrong. What is left in the band is the title and
 * the update offer.
 */
export function TitleBar({
  title,
  update,
  onInstallUpdate,
  onRelaunchUpdate,
}: {
  /** What this window is showing right now — the open chat, or the view. */
  title: string;
  /**
   * Where the divider goes: the total width of the columns to the LEFT of the
   * content pane (the rail, plus the chat list on the Chats view).
   *
   * Passed in rather than measured, and rather than assumed here, because the
   * shell is the only party that knows both — and the whole point is that the
   * divider lands exactly on the column border below it.
   */
  update: FooterUpdate;
  onInstallUpdate?: () => void;
  onRelaunchUpdate?: () => void;
}): React.JSX.Element {
  return (
    <header
      data-slot="titlebar"
      // `h-11` is not a free choice: it is what centres the window buttons on
      // this row, and `TRAFFIC_LIGHT_INSET.y` is the other half of that
      // arithmetic. They move together.
      // NO `gap` on this row. The leading zone's whole job is to end exactly on
      // the columns' border, and a flex gap displaces everything after it by
      // its own width — measured at 8px out, which put the divider that used to
      // be drawn there beside the border instead of on it, and still shifts the
      // centre the title is measured from. Spacing belongs to the children.
      className="app-drag relative flex h-11 shrink-0 items-center border-b border-sidebar-border bg-sidebar pr-2"
      style={{ paddingLeft: TITLEBAR_CONTENT_INSET }}>
      {/* Centred on the WINDOW, which is what every native title bar does and
          the only definition of "in the middle" that does not move.

          It was briefly centred over the CONTENT PANE instead, measured from a
          `leadingWidth` the shell added up from the column widths. That is
          right until a column opens on the OTHER side: with the agents panel
          out, the midpoint of "everything right of the chat list" sits well
          right of the transcript, and the title visibly drifted with it —
          measured 1322px into a 2000px window. Bounding both sides would mean
          the panel reporting its width up on every frame of a resize drag, to
          move a label a few dozen pixels.

          `absolute` rather than a centred flex child because the controls to
          its right appear and disappear, and a flex centre would drift each
          time one did. `pointer-events-none` keeps it part of the drag region
          rather than a dead strip through the middle of it. */}
      <span
        data-slot="titlebar-title"
        className="pointer-events-none absolute left-1/2 max-w-[40%] -translate-x-1/2 truncate text-xs font-medium text-muted-foreground">
        {title}
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <UpdateControl
          update={update}
          onInstall={onInstallUpdate}
          onRelaunch={onRelaunchUpdate}
        />
      </div>
    </header>
  );
}
