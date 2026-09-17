import { ChevronDown, Pencil, Plus, TerminalIcon, X } from 'lucide-react';
import { lazy, Suspense, useRef, useState } from 'react';

import { PROFILE_COLORS, type ProfileColor } from '../../shared/contracts';
import { InlineRenameInput } from '../components/inline-rename-input';
import { PanelResizeHandle, usePanelWidth } from '../components/panel-resize';
import { Button } from '../components/ui/button';
import { Menu } from '../components/ui/menu';
import { PALETTE_LABEL } from '../components/ui/palette';
import { PaletteDot } from '../components/ui/palette-dot';
import { cn } from '../components/ui/utils';
import {
  MAX_TERMINAL_TAB_NAME,
  type TerminalTab,
  terminalTabLabel,
  type TerminalTabs,
} from './use-terminal-tabs';

/** The menu's two non-colour rows, kept apart from any palette value. */
const RENAME_ROW = 'rename';
const NO_COLOR_ROW = 'no-color';

function isProfileColor(value: string): value is ProfileColor {
  return (PROFILE_COLORS as readonly string[]).includes(value);
}

// Split out: xterm and its stylesheet are only worth loading once somebody
// actually opens a terminal.
const TerminalView = lazy(() => import('./terminal-view'));

/**
 * The app's own terminal: a panel docked across the bottom of the window, one
 * tab per shell, spanning whatever view is open — the same place and the same
 * reasoning as the debug drawer.
 *
 * HIDDEN rather than unmounted while closed: unmounting would end every shell
 * and lose its scrollback, and hiding a panel is not a request to do either.
 */
export function TerminalPanel({
  terminals,
  onNewTab,
}: {
  terminals: TerminalTabs;
  /** Where "+" opens: the shell decides, since it knows the open chat. */
  onNewTab: () => void;
}): React.JSX.Element | null {
  const { tabs, activeKey, open } = terminals;
  const {
    width: height,
    minWidth,
    maxWidth,
    startResize,
    resizeTo,
  } = usePanelWidth({
    storageKey: 'terminal.panelHeight',
    defaultWidth: 280,
    minWidth: 120,
    maxWidth: 900,
    handleEdge: 'top',
  });

  // Nothing until the first tab, and after that HIDDEN rather than unmounted.
  if (tabs.length === 0) {
    return null;
  }

  return (
    <aside
      className={cn(
        'relative flex shrink-0 flex-col border-t border-border bg-sidebar',
        !open && 'hidden',
      )}
      style={{ height }}
      aria-label="Terminal">
      <PanelResizeHandle
        edge="top"
        label="Resize terminal panel"
        onMouseDown={startResize}
        value={height}
        min={minWidth}
        max={maxWidth}
        onResize={resizeTo}
      />
      <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
        <div
          role="group"
          aria-label="Terminals"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <TerminalTabButton
              key={tab.key}
              tab={tab}
              active={tab.key === activeKey}
              onSelect={() => terminals.selectTab(tab.key)}
              onClose={() => terminals.closeTab(tab.key)}
              onRename={(name) => terminals.renameTab(tab.key, name)}
              onRecolor={(color) => terminals.setTabColor(tab.key, color)}
            />
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label="New terminal"
          title="New terminal"
          onClick={onNewTab}>
          <Plus className="size-3.5 shrink-0" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label="Hide the terminal panel"
          title="Hide — the shells keep running (⌃`)"
          onClick={terminals.hide}>
          <ChevronDown className="size-3.5 shrink-0" />
        </Button>
      </div>
      <Suspense fallback={null}>
        {tabs.map((tab) => (
          <TerminalView
            key={tab.key}
            cwd={tab.cwd}
            shown={open && tab.key === activeKey}
            onEnded={(ending) => {
              // A shell the user worked in closes its tab whatever its code: a
              // bare `exit` or ⌃D returns the LAST command's status. A kill, a
              // shell that never started, or one that died before any input — a
              // broken login rc — keeps the tab, so what went wrong stays readable.
              if (
                ending.kind === 'exited' &&
                ending.signal === null &&
                ending.used
              ) {
                terminals.closeTab(tab.key);
              } else {
                terminals.markExited(
                  tab.key,
                  ending.kind === 'exited' ? ending.exitCode : 1,
                );
              }
            }}
          />
        ))}
      </Suspense>
    </aside>
  );
}

/**
 * One tab: its options control, its name, and its close button — siblings
 * rather than nested, since a button inside a button is invalid and a press on
 * the × would select the tab too.
 *
 * The leading control IS the colour, so it is what changes it — the sidebar
 * groups' arrangement — and the same menu carries Rename for a keyboard user;
 * double-clicking the name is the quick path to the same field.
 */
function TerminalTabButton({
  tab,
  active,
  onSelect,
  onClose,
  onRename,
  onRecolor,
}: {
  tab: TerminalTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onRecolor: (color: ProfileColor | null) => void;
}): React.JSX.Element {
  const label = terminalTabLabel(tab);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      className={cn(
        'group flex h-6 shrink-0 items-center rounded-md',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50',
      )}>
      <span className="relative inline-flex shrink-0">
        <button
          ref={menuTriggerRef}
          type="button"
          data-menu-trigger
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          aria-label={`Options for terminal ${label}`}
          title="Colour and name"
          onClick={() => setMenuOpen((open) => !open)}
          className="ml-1 flex size-5 items-center justify-center rounded-sm text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          {tab.color === null ? (
            <TerminalIcon aria-hidden="true" className="size-3 shrink-0" />
          ) : (
            <PaletteDot
              data-slot="terminal-tab-color"
              color={tab.color}
              size="sm"
            />
          )}
        </button>
        <Menu
          open={menuOpen}
          side="top"
          align="start"
          anchor="viewport"
          triggerRef={menuTriggerRef}
          className="w-44 min-w-0"
          value={tab.color ?? NO_COLOR_ROW}
          groups={[
            {
              label: 'Colour',
              items: [
                ...PROFILE_COLORS.map((color) => ({
                  value: color,
                  label: PALETTE_LABEL[color],
                  icon: <PaletteDot color={color} />,
                })),
                { value: NO_COLOR_ROW, label: 'No colour' },
              ],
            },
            {
              items: [
                {
                  value: RENAME_ROW,
                  label: 'Rename tab…',
                  icon: <Pencil className="size-3.5" />,
                  action: true,
                },
              ],
            },
          ]}
          onSelect={(value) => {
            setMenuOpen(false);
            if (value === RENAME_ROW) {
              setEditing(true);
            } else if (value === NO_COLOR_ROW) {
              onRecolor(null);
            } else if (isProfileColor(value)) {
              onRecolor(value);
            }
          }}
          onClose={() => setMenuOpen(false)}
        />
      </span>
      {editing ? (
        <InlineRenameInput
          value={label}
          maxLength={MAX_TERMINAL_TAB_NAME}
          ariaLabel={`Rename terminal ${label}`}
          className="mx-1 h-5 w-32 px-1 text-xs"
          onCommit={(name) => {
            setEditing(false);
            onRename(name);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          aria-pressed={active}
          title={`${tab.cwd ?? 'Home folder'} — double-click to rename`}
          onClick={onSelect}
          onDoubleClick={() => setEditing(true)}
          className="flex h-full items-center pr-1 pl-1 text-xs outline-none focus-visible:underline">
          <span
            className={cn(
              'max-w-40 truncate',
              tab.exitCode !== null && 'line-through',
            )}>
            {label}
          </span>
        </button>
      )}
      <button
        type="button"
        aria-label={`Close terminal ${label}`}
        title="Close — ends this shell"
        onClick={onClose}
        className="mr-1 flex size-4 items-center justify-center rounded-sm text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <X className="size-3 shrink-0" />
      </button>
    </div>
  );
}
