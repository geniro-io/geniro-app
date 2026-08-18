import {
  ChartColumn,
  type LucideIcon,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Terminal,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

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
  updateVersion,
  onInstallUpdate,
  daemonVersion,
  debugOpen,
  onToggleDebug,
}: {
  view: AppView;
  onNavigate: (view: AppView) => void;
  connected: boolean;
  /**
   * The version waiting to be installed, or null when there is none to offer.
   *
   * Resolved by the caller from main's one `UpdateState` rather than read here:
   * this row renders the offer, it does not decide there is one — the same
   * split the banner and Settings already follow, so three surfaces cannot
   * disagree about whether an update exists.
   */
  updateVersion: string | null;
  /** Apply it. Absent when the app cannot replace its own install. */
  onInstallUpdate?: () => void;
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
    updateVersion && connected && daemonVersion
      ? `v${daemonVersion}`
      : statusLabel;

  return (
    <nav
      className={cn(
        'flex shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-3',
        hydrated && 'transition-[width]',
        collapsed ? 'w-14' : 'w-[220px]',
      )}>
      <div
        className={cn(
          'mb-3 flex items-center pt-1',
          collapsed ? 'justify-center' : 'justify-between px-2',
        )}>
        {collapsed ? null : <Logo size="nav" />}
        <button
          type="button"
          aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
          title={collapsed ? 'Expand menu' : 'Collapse menu'}
          onClick={toggleCollapsed}
          className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/50">
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" className="size-4" />
          ) : (
            <PanelLeftClose aria-hidden="true" className="size-4" />
          )}
        </button>
      </div>

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
          {/* The update offer, HERE because this is the row that already states
              which version is running — the user asked to be told about a new
              one where the current one is written, and to act on it without
              going anywhere. The banner over the views still exists and is not
              replaced: it is what interrupts, this is what waits.

              Rendered only when there is something to DO. An update the app
              cannot install itself (a read-only volume, another account's
              install) offers no button here — Settings carries the `brew`
              sentence for that case, and a button that cannot work is worse
              than none in a row this small. */}
          {!collapsed && updateVersion && onInstallUpdate ? (
            <button
              type="button"
              title={`Update to Geniro ${updateVersion}`}
              onClick={onInstallUpdate}
              className="ml-auto shrink-0 rounded-md bg-sidebar-primary px-2 py-0.5 text-[11px] font-medium text-sidebar-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50">
              Update
            </button>
          ) : null}
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
              collapsed ? 'mt-1' : updateVersion ? 'ml-1' : 'ml-auto',
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
