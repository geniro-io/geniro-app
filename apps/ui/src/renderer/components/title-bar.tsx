import { Terminal } from 'lucide-react';

import { TITLEBAR_CONTENT_INSET } from '../../shared/contracts';
import type { FooterUpdate } from '../updates/update-status';
import { StatusDot } from './status-dot';
import { cn } from './ui/utils';
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
 */
export function TitleBar({
  title,
  connected,
  daemonVersion,
  update,
  onInstallUpdate,
  onRelaunchUpdate,
  debugOpen,
  onToggleDebug,
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
  /** Whether the daemon is answering — the dot's tone. */
  connected: boolean;
  /** The running daemon's version, for the readout beside the dot. */
  daemonVersion: string | null;
  update: FooterUpdate;
  onInstallUpdate?: () => void;
  onRelaunchUpdate?: () => void;
  /** Whether the debug drawer is showing — the trigger's pressed state. */
  debugOpen: boolean;
  onToggleDebug: () => void;
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
        {/* Connection + version. Both lived in the rail's footer under a
              rule, where collapsing the rail reduced them to one green pip
              alone under a line — a readout with nothing to read it against.
              Here they sit with the other things that describe the app rather
              than a column, and the version is beside the update that offers a
              newer one, which is the comparison a user actually makes. */}
        <span
          data-slot="titlebar-status"
          title={
            connected
              ? `connected to the daemon${daemonVersion ? ` · v${daemonVersion}` : ''}`
              : 'not connected to the daemon'
          }
          className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <StatusDot tone={connected ? 'ok' : 'bad'} />
          <span className="truncate">
            {connected
              ? daemonVersion
                ? `v${daemonVersion}`
                : 'connected'
              : 'disconnected'}
          </span>
        </span>
        <UpdateControl
          update={update}
          onInstall={onInstallUpdate}
          onRelaunch={onRelaunchUpdate}
        />
        {/* The debug trigger. It sat in the rail's footer beside the status
            dot, on the reasoning that the footer is where the eye goes when
            something is wrong. The title bar is now where every global control
            lives, and "show me why" is one — the footer keeps the status
            itself, which is the part that is a READOUT rather than an action. */}
        <button
          type="button"
          aria-label="Debug log"
          aria-pressed={debugOpen}
          title="Debug log (⌥⌘L)"
          onClick={onToggleDebug}
          className={cn(
            'app-no-drag flex size-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
            debugOpen
              ? 'text-sidebar-primary-strong'
              : 'text-sidebar-foreground/70',
          )}>
          <Terminal aria-hidden="true" className="size-3.5 shrink-0" />
        </button>
      </div>
    </header>
  );
}
