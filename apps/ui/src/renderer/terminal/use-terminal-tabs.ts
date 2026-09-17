import { useCallback, useReducer } from 'react';

import type { ProfileColor } from '../../shared/contracts';

/** Longer names are cut: a tab is a label in a strip, not a place to write. */
export const MAX_TERMINAL_TAB_NAME = 60;

export interface TerminalTab {
  /** React identity only — each mount of the view starts its own shell. */
  readonly key: string;
  /** Where the shell starts; null is the home folder. */
  readonly cwd: string | null;
  /** The user's own name for the tab; null shows the folder's name. */
  readonly name: string | null;
  /** A colour from the app's palette, or none. */
  readonly color: ProfileColor | null;
  /** Set once the shell was killed or never started, so the tab stays readable. */
  readonly exitCode: number | null;
}

export interface TerminalTabsState {
  readonly tabs: readonly TerminalTab[];
  readonly activeKey: string | null;
  /** Hiding the panel keeps every shell running; only closing a tab ends one. */
  readonly open: boolean;
}

export type TerminalTabsAction =
  | { type: 'open-tab'; key: string; cwd: string | null }
  | { type: 'close-tab'; key: string }
  | { type: 'select'; key: string }
  | { type: 'exited'; key: string; exitCode: number }
  | { type: 'rename'; key: string; name: string }
  | { type: 'recolor'; key: string; color: ProfileColor | null }
  | { type: 'toggle'; key: string; cwd: string | null }
  | { type: 'hide' };

export const INITIAL_TERMINAL_TABS: TerminalTabsState = {
  tabs: [],
  activeKey: null,
  open: false,
};

export function terminalTabsReducer(
  state: TerminalTabsState,
  action: TerminalTabsAction,
): TerminalTabsState {
  switch (action.type) {
    case 'open-tab':
      return {
        tabs: [
          ...state.tabs,
          {
            key: action.key,
            cwd: action.cwd,
            name: null,
            color: null,
            exitCode: null,
          },
        ],
        activeKey: action.key,
        open: true,
      };
    case 'close-tab': {
      const index = state.tabs.findIndex((tab) => tab.key === action.key);
      if (index === -1) {
        return state;
      }
      const tabs = state.tabs.filter((tab) => tab.key !== action.key);
      // The neighbour that slides into the closed tab's place, as a browser does.
      const activeKey =
        state.activeKey !== action.key
          ? state.activeKey
          : (tabs[Math.min(index, tabs.length - 1)]?.key ?? null);
      return { tabs, activeKey, open: state.open && tabs.length > 0 };
    }
    case 'select':
      return state.tabs.some((tab) => tab.key === action.key)
        ? { ...state, activeKey: action.key, open: true }
        : state;
    case 'exited':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.key === action.key ? { ...tab, exitCode: action.exitCode } : tab,
        ),
      };
    case 'rename': {
      // A blank name gives the tab back its folder's name rather than leaving
      // a label with nothing in it.
      const name = action.name.trim().slice(0, MAX_TERMINAL_TAB_NAME);
      return updateTab(state, action.key, { name: name === '' ? null : name });
    }
    case 'recolor':
      return updateTab(state, action.key, { color: action.color });
    case 'toggle':
      if (state.open) {
        return { ...state, open: false };
      }
      // Showing an empty panel would be a control with nothing to use, so the
      // first toggle is also the first shell.
      return state.tabs.length === 0
        ? terminalTabsReducer(state, {
            type: 'open-tab',
            key: action.key,
            cwd: action.cwd,
          })
        : { ...state, open: true };
    case 'hide':
      return { ...state, open: false };
  }
}

function updateTab(
  state: TerminalTabsState,
  key: string,
  patch: Partial<Pick<TerminalTab, 'name' | 'color'>>,
): TerminalTabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.key === key ? { ...tab, ...patch } : tab,
    ),
  };
}

export interface TerminalTabs extends TerminalTabsState {
  openTab(cwd: string | null): void;
  closeTab(key: string): void;
  selectTab(key: string): void;
  markExited(key: string, exitCode: number): void;
  renameTab(key: string, name: string): void;
  setTabColor(key: string, color: ProfileColor | null): void;
  toggle(cwd: string | null): void;
  hide(): void;
}

/** The terminal panel's tabs, held by the shell so they outlive a view switch. */
export function useTerminalTabs(): TerminalTabs {
  const [state, dispatch] = useReducer(
    terminalTabsReducer,
    INITIAL_TERMINAL_TABS,
  );
  const openTab = useCallback((cwd: string | null) => {
    dispatch({ type: 'open-tab', key: crypto.randomUUID(), cwd });
  }, []);
  const closeTab = useCallback((key: string) => {
    dispatch({ type: 'close-tab', key });
  }, []);
  const selectTab = useCallback((key: string) => {
    dispatch({ type: 'select', key });
  }, []);
  const markExited = useCallback((key: string, exitCode: number) => {
    dispatch({ type: 'exited', key, exitCode });
  }, []);
  const renameTab = useCallback((key: string, name: string) => {
    dispatch({ type: 'rename', key, name });
  }, []);
  const setTabColor = useCallback((key: string, color: ProfileColor | null) => {
    dispatch({ type: 'recolor', key, color });
  }, []);
  const toggle = useCallback((cwd: string | null) => {
    dispatch({ type: 'toggle', key: crypto.randomUUID(), cwd });
  }, []);
  const hide = useCallback(() => {
    dispatch({ type: 'hide' });
  }, []);
  return {
    ...state,
    openTab,
    closeTab,
    selectTab,
    markExited,
    renameTab,
    setTabColor,
    toggle,
    hide,
  };
}

/**
 * Where "+" starts a shell: the open chat's folder, else the folder of the tab
 * on screen — someone working in a terminal wants the next one beside it — else
 * home.
 */
export function newTerminalFolder(
  chatFolder: string | null,
  state: TerminalTabsState,
): string | null {
  if (chatFolder !== null) {
    return chatFolder;
  }
  return state.tabs.find((tab) => tab.key === state.activeKey)?.cwd ?? null;
}

/** What a tab is called: the user's name for it, else its folder's name. */
export function terminalTabLabel(
  tab: Pick<TerminalTab, 'name' | 'cwd'>,
): string {
  return tab.name ?? terminalTabTitle(tab.cwd);
}

/** A tab's default label: the folder's own name, which tells two tabs apart. */
export function terminalTabTitle(cwd: string | null): string {
  if (cwd === null) {
    return '~';
  }
  return cwd.split('/').filter(Boolean).pop() ?? '/';
}
