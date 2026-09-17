import { ChevronDown, Plus, TerminalIcon, X } from 'lucide-react';
import { lazy, Suspense } from 'react';

import { PanelResizeHandle, usePanelWidth } from '../components/panel-resize';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import {
  type TerminalTab,
  type TerminalTabs,
  terminalTabTitle,
} from './use-terminal-tabs';

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
 * Two sibling buttons rather than a close control nested in the tab: a button
 * inside a button is invalid, and a press on the × would select the tab too.
 */
function TerminalTabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: TerminalTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const title = terminalTabTitle(tab.cwd);
  return (
    <div
      className={cn(
        'group flex h-6 shrink-0 items-center rounded-md',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50',
      )}>
      <button
        type="button"
        aria-pressed={active}
        title={tab.cwd ?? 'Home folder'}
        onClick={onSelect}
        className="flex h-full items-center gap-1.5 pr-1 pl-2 text-xs outline-none focus-visible:underline">
        <TerminalIcon className="size-3 shrink-0" />
        <span
          className={cn(
            'max-w-40 truncate',
            tab.exitCode !== null && 'line-through',
          )}>
          {title}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Close terminal ${title}`}
        title="Close — ends this shell"
        onClick={onClose}
        className="mr-1 flex size-4 items-center justify-center rounded-sm text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <X className="size-3 shrink-0" />
      </button>
    </div>
  );
}
