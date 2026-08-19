import {
  ArrowDownToLine,
  ChartColumn,
  type LucideIcon,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCw,
  Settings,
  Terminal,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { FooterUpdate } from '../updates/update-status';
import { Logo } from './logo';
import { StatusDot } from './status-dot';
import { cn } from './ui/utils';

/** The top-level views the nav rail switches between. */
export type AppView = 'chats' | 'graphs' | 'stats' | 'settings';

interface NavItem {
  view: AppView;
  label: string;
  icon: LucideIcon;
}

/** Primary destinations (pinned to the top). */
const PRIMARY_ITEMS: readonly NavItem[] = [
  { view: 'chats', label: 'Chats', icon: MessageSquare },
  { view: 'graphs', label: 'Graphs', icon: Workflow },
  { view: 'stats', label: 'Stats', icon: ChartColumn },
];

/** Utility destinations (pinned to the bottom). */
const SECONDARY_ITEMS: readonly NavItem[] = [
  { view: 'settings', label: 'Settings', icon: Settings },
];

function NavButton({
  item,
  active,
  collapsed,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onSelect: (view: AppView) => void;
}): React.JSX.Element {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      // When collapsed the label is hidden — keep it reachable to assistive tech
      // and surface it as a hover tooltip.
      aria-label={collapsed ? item.label : undefined}
      title={collapsed ? item.label : undefined}
      onClick={() => onSelect(item.view)}
      className={cn(
        'flex w-full items-center rounded-md text-left text-sm font-medium outline-none transition-colors',
        'hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
        collapsed ? 'justify-center px-0 py-2' : 'gap-3 px-3 py-2',
        active
          ? 'bg-sidebar-accent text-sidebar-primary-strong'
          : 'text-sidebar-foreground/75',
      )}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {collapsed ? null : item.label}
    </button>
  );
}

/**
 * The rail's own width toggle.
 *
 * Extracted because it is rendered from two places — inside the title bar when
 * the rail is open, and on a row of its own when it is collapsed and the
 * traffic lights have taken the title bar for themselves — and a second copy is
 * how the two would come to disagree about the label a screen reader hears.
 */
function CollapseButton({
  collapsed,
  onToggle,
  className,
}: {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
      title={collapsed ? 'Expand menu' : 'Collapse menu'}
      onClick={onToggle}
      // A press inside a drag region belongs to the WINDOW — the click never
      // reaches React — so the one control living in the title bar has to opt
      // out of it. Harmless on the collapsed row, which is not a drag region.
      className={cn(
        'app-no-drag flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
        className,
      )}>
      {collapsed ? (
        <PanelLeftOpen aria-hidden="true" className="size-4" />
      ) : (
        <PanelLeftClose aria-hidden="true" className="size-4" />
      )}
    </button>
  );
}

/**
 * The app's persistent left navigation. The single home for switching between
 * the top-level surfaces (Chats, Graphs, Stats, Settings) plus the Geniro mark and the
 * live daemon-connection indicator. Collapses to an icon-only rail — REMEMBERED
 * across launches in `settings.json` — and collapsed items expose their label
 * as a tooltip + aria-label.
 */
export function NavRail({
  view,
  onNavigate,
  connected,
  update,
  onInstallUpdate,
  onRelaunchUpdate,
  daemonVersion,
  debugOpen,
  onToggleDebug,
}: {
  view: AppView;
  onNavigate: (view: AppView) => void;
  connected: boolean;
  /**
   * What this row offers for an update, already resolved by the caller.
   *
   * A projection of main's one `UpdateState` (`footerUpdate`), not the state
   * itself: this row RENDERS the offer, it does not decide there is one — the
   * same split Settings follows, so the two surfaces cannot disagree about
   * whether an update exists. It is a value rather than a version string
   * because this row is now the app's ONLY update channel, so it has to carry
   * a download in flight and a failed install as well as an offer.
   */
  update: FooterUpdate;
  /** Start the download for an `install`, or try again after an `error`. */
  onInstallUpdate?: () => void;
  /** Restart into a bundle that has finished installing (`restart`). */
  onRelaunchUpdate?: () => void;
  daemonVersion: string | null;
  /** Whether the debug drawer is showing — the trigger's pressed state. */
  debugOpen: boolean;
  onToggleDebug: () => void;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  // Whether the stored choice has been applied yet. Until it has, the width is
  // NOT animated: the settings read resolves a frame or two after mount, and an
  // animated correction would show every launch sliding the rail shut — which
  // looks like the app forgetting and then remembering, rather than opening the
  // way it was left.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.geniro
      .getSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        setCollapsed(settings.sidebarCollapsed);
        setHydrated(true);
      })
      // Swallowed to the DEFAULT, not to a broken rail: an unreadable settings
      // file must cost the remembered width and nothing else.
      .catch(() => {
        if (!cancelled) {
          setHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleCollapsed = useCallback((): void => {
    setCollapsed((prev) => {
      const next = !prev;
      // Fire-and-forget: the rail has already moved, and a settings write that
      // fails must not undo the gesture the user just made.
      void window.geniro.updateSettings({ sidebarCollapsed: next });
      return next;
    });
  }, []);

  const statusLabel = connected
    ? `connected${daemonVersion ? ` · v${daemonVersion}` : ''}`
    : 'disconnected';
  /**
   * The same row with an Update button in it has no space for the word
   * "connected" as well, and truncating swallowed the VERSION — the one part
   * the user is reading when they compare it with the version on offer. The
   * status DOT beside it already says connected, so the word is what gives way.
   * A disconnected rail keeps its word: no dot colour is worth that much on its
   * own, and there is no update to press while the daemon is unreachable.
   */
  const footerLabel =
    update.kind !== 'none' && connected && daemonVersion
      ? `v${daemonVersion}`
      : statusLabel;

  return (
    <nav
      className={cn(
        'flex shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar px-3 pb-3',
        hydrated && 'transition-[width]',
        // 64px rather than 56: this rail's top row is now the window's title
        // bar, and the traffic lights it has to hold are 52px wide beside a
        // 10px inset. A narrower rail would put the system's own buttons over
        // the border and into the column beside it.
        collapsed ? 'w-16' : 'w-[220px]',
      )}>
      {/* THE TITLE BAR. `pt-0` on the nav above is what lets this row start at
          the very top of the window, where the OS strip used to be, and `h-11`
          is what centres the traffic lights on it — `trafficLightPosition`
          in `main/index.ts` is the other half of that arithmetic and moves
          with it. The left inset is the lights' own footprint (10 + 52),
          minus the rail's padding. */}
      <div
        data-slot="titlebar"
        className={cn(
          'app-drag flex h-11 shrink-0 items-center',
          collapsed ? null : 'mb-2 gap-2 pl-[50px]',
        )}>
        {collapsed ? null : (
          <>
            <Logo size="nav" />
            <CollapseButton
              collapsed={collapsed}
              onToggle={toggleCollapsed}
              className="ml-auto"
            />
          </>
        )}
      </div>
      {/* Collapsed, the lights fill the title row on their own, so the toggle
          takes a row of its own rather than sitting underneath them. */}
      {collapsed ? (
        <div className="mb-2 flex justify-center">
          <CollapseButton collapsed={collapsed} onToggle={toggleCollapsed} />
        </div>
      ) : null}

      {PRIMARY_ITEMS.map((item) => (
        <NavButton
          key={item.view}
          item={item}
          active={view === item.view}
          collapsed={collapsed}
          onSelect={onNavigate}
        />
      ))}

      <div className="mt-auto flex flex-col gap-1">
        {SECONDARY_ITEMS.map((item) => (
          <NavButton
            key={item.view}
            item={item}
            active={view === item.view}
            collapsed={collapsed}
            onSelect={onNavigate}
          />
        ))}
        <div
          title={collapsed ? statusLabel : undefined}
          className={cn(
            'mt-2 flex items-center border-t border-sidebar-border pt-3 text-xs text-muted-foreground',
            collapsed ? 'justify-center' : 'gap-2 px-3',
          )}>
          {/* Collapsed, the dot is the only thing left on this row beside the
              debug trigger — a bare coloured pip with nothing to label it,
              which reads as decoration rather than as status. The row's own
              `title` still carries the state in words, and the connection
              banner is what actually announces a drop. */}
          {collapsed ? null : <StatusDot tone={connected ? 'ok' : 'bad'} />}
          {/* `truncate` rather than wrap: with the update button beside it the
              label no longer has the row to itself, and "connected · v0.1.0"
              broke onto a second line, making the footer two rows tall. */}
          {collapsed ? null : <span className="truncate">{footerLabel}</span>}
          {/* The update offer, and the app's ONLY one — the strip that used to
              sit over the views is gone. Two controls for one action in one
              window is what got reported, and of the two this is the one that
              belongs: it is the row already stating which version is running,
              so a newer one is read where the current one is written.

              Deliberately NOT a filled button. A primary pill in a 220px status
              row is the loudest thing in the shell, for an offer that is not
              urgent and has no deadline — so it is a text affordance at the
              row's own size, carrying a glyph and a version and nothing else.
              The sentence lives in `title` and in Settings; this is a hint, not
              a paragraph.

              Shown COLLAPSED as the glyph alone, which the strip's removal made
              necessary rather than optional: a user who works with the rail
              collapsed would otherwise have no channel left that mentions an
              update at all. */}
          {update.kind === 'none' ? null : update.kind === 'readout' ? (
            // Deliberately NOT a button. This offer is real but THIS install
            // cannot apply it (a Homebrew install, a translocated copy), and
            // the rail's own rule is "no dead affordance" — a control that
            // cannot work is worse than none. `title` carries the command
            // that does.
            <span
              data-slot="update-readout"
              aria-label={update.title}
              title={update.title}
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-md text-[11px] font-medium text-muted-foreground',
                collapsed ? 'mt-1 justify-center p-1' : 'ml-auto px-1 py-0.5',
              )}>
              <ArrowDownToLine aria-hidden="true" className="size-3 shrink-0" />
              {collapsed ? null : <span>{update.label}</span>}
            </span>
          ) : (
            <button
              type="button"
              data-slot="update-control"
              // A real label whatever the width — collapsed there is no text
              // beside it, and `title` alone is invisible to assistive tech.
              aria-label={update.title}
              title={update.title}
              // `progress` is a state, not a control: the download is already
              // running and there is nothing a press could add.
              disabled={update.kind === 'progress'}
              onClick={
                update.kind === 'restart' ? onRelaunchUpdate : onInstallUpdate
              }
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-md text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
                collapsed ? 'mt-1 justify-center p-1' : 'ml-auto px-1 py-0.5',
                update.kind === 'progress'
                  ? 'text-muted-foreground'
                  : 'hover:bg-sidebar-accent',
                update.kind === 'error'
                  ? 'text-destructive'
                  : update.kind === 'progress'
                    ? ''
                    : 'text-sidebar-primary-strong',
              )}>
              {update.kind === 'restart' ? (
                <RotateCw aria-hidden="true" className="size-3 shrink-0" />
              ) : update.kind === 'error' ? (
                <TriangleAlert aria-hidden="true" className="size-3 shrink-0" />
              ) : (
                <ArrowDownToLine
                  aria-hidden="true"
                  className={cn(
                    'size-3 shrink-0',
                    // Only while something is actually moving. A standing offer
                    // that pulses is the pill's loudness back in another form.
                    update.kind === 'progress' && 'animate-pulse',
                  )}
                />
              )}
              {collapsed ? null : <span>{update.label}</span>}
            </button>
          )}
          {/* The debug drawer's trigger, deliberately HERE. This row is
              already where the eye goes when something is wrong — it is the
              only part of the shell that reports health — so the control for
              "show me why" belongs beside it rather than in a menu. */}
          <button
            type="button"
            aria-label="Debug log"
            aria-pressed={debugOpen}
            title="Debug log (⌥⌘L)"
            onClick={onToggleDebug}
            className={cn(
              'flex size-6 items-center justify-center rounded-md outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
              // `ml-auto` only when nothing else has claimed the gap: with an
              // update button present, two auto margins split the space and
              // push the status text off-centre.
              collapsed ? 'mt-1' : update.kind !== 'none' ? 'ml-1' : 'ml-auto',
              debugOpen
                ? 'text-sidebar-primary-strong'
                : 'text-sidebar-foreground/70',
            )}>
            <Terminal aria-hidden="true" className="size-3.5 shrink-0" />
          </button>
        </div>
      </div>
    </nav>
  );
}
