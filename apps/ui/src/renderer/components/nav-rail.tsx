import {
  type LucideIcon,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Workflow,
} from 'lucide-react';
import { useState } from 'react';

import { Logo } from './logo';
import { StatusDot } from './status-dot';
import { cn } from './ui/utils';

/** The top-level views the nav rail switches between. */
export type AppView = 'chats' | 'graphs' | 'settings';

interface NavItem {
  view: AppView;
  label: string;
  icon: LucideIcon;
}

/** Primary destinations (pinned to the top). */
const PRIMARY_ITEMS: readonly NavItem[] = [
  { view: 'chats', label: 'Chats', icon: MessageSquare },
  { view: 'graphs', label: 'Graphs', icon: Workflow },
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
 * the top-level surfaces (Chats, Graphs, Settings) plus the Geniro mark and the
 * live daemon-connection indicator. Collapses to an icon-only rail (state kept
 * for the session); collapsed items expose their label as a tooltip + aria-label.
 */
export function NavRail({
  view,
  onNavigate,
  connected,
  daemonVersion,
}: {
  view: AppView;
  onNavigate: (view: AppView) => void;
  connected: boolean;
  daemonVersion: string | null;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);

  const statusLabel = connected
    ? `connected${daemonVersion ? ` · v${daemonVersion}` : ''}`
    : 'disconnected';

  return (
    <nav
      className={cn(
        'flex shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-3 transition-[width]',
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
          onClick={() => setCollapsed((prev) => !prev)}
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
          <StatusDot tone={connected ? 'ok' : 'bad'} />
          {collapsed ? null : statusLabel}
        </div>
      </div>
    </nav>
  );
}
