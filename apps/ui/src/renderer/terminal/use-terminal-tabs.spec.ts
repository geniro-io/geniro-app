import { describe, expect, it } from 'vitest';

import {
  INITIAL_TERMINAL_TABS,
  newTerminalFolder,
  type TerminalTabsAction,
  terminalTabsReducer,
  terminalTabTitle,
} from './use-terminal-tabs';

function run(...actions: TerminalTabsAction[]) {
  return actions.reduce(terminalTabsReducer, INITIAL_TERMINAL_TABS);
}

describe('terminalTabsReducer', () => {
  it('opens a tab, selects it and shows the panel', () => {
    const state = run({ type: 'open-tab', key: 'a', cwd: '/proj' });

    expect(state).toEqual({
      tabs: [{ key: 'a', cwd: '/proj', exitCode: null }],
      activeKey: 'a',
      open: true,
    });
  });

  it('starts a shell on the first toggle rather than showing an empty panel', () => {
    const state = run({ type: 'toggle', key: 'a', cwd: '/proj' });

    expect(state.open).toBe(true);
    expect(state.tabs.map((tab) => tab.cwd)).toEqual(['/proj']);
  });

  it('hides and re-shows the panel without touching its tabs', () => {
    const shown = run({ type: 'open-tab', key: 'a', cwd: '/proj' });
    const hidden = terminalTabsReducer(shown, {
      type: 'toggle',
      key: 'b',
      cwd: '/other',
    });
    const again = terminalTabsReducer(hidden, {
      type: 'toggle',
      key: 'c',
      cwd: '/other',
    });

    expect(hidden.open).toBe(false);
    expect(hidden.tabs).toBe(shown.tabs);
    expect(again.open).toBe(true);
    expect(again.tabs.map((tab) => tab.key)).toEqual(['a']);
  });

  it('selects the neighbour that takes a closed active tab’s place', () => {
    const state = run(
      { type: 'open-tab', key: 'a', cwd: null },
      { type: 'open-tab', key: 'b', cwd: null },
      { type: 'open-tab', key: 'c', cwd: null },
      { type: 'select', key: 'b' },
      { type: 'close-tab', key: 'b' },
    );

    expect(state.tabs.map((tab) => tab.key)).toEqual(['a', 'c']);
    expect(state.activeKey).toBe('c');
  });

  it('keeps the selection when a background tab closes', () => {
    const state = run(
      { type: 'open-tab', key: 'a', cwd: null },
      { type: 'open-tab', key: 'b', cwd: null },
      { type: 'close-tab', key: 'a' },
    );

    expect(state.activeKey).toBe('b');
  });

  it('closes the panel with its last tab', () => {
    const state = run(
      { type: 'open-tab', key: 'a', cwd: null },
      { type: 'close-tab', key: 'a' },
    );

    expect(state).toEqual({ tabs: [], activeKey: null, open: false });
  });

  it('records a failed exit on its own tab only', () => {
    const state = run(
      { type: 'open-tab', key: 'a', cwd: null },
      { type: 'open-tab', key: 'b', cwd: null },
      { type: 'exited', key: 'a', exitCode: 127 },
    );

    expect(state.tabs.map((tab) => tab.exitCode)).toEqual([127, null]);
  });
});

describe('terminalTabTitle', () => {
  it('names a tab by its folder, and the home folder by ~', () => {
    expect(terminalTabTitle('/Users/me/work/geniro-app')).toBe('geniro-app');
    expect(terminalTabTitle('/Users/me/work/geniro-app/')).toBe('geniro-app');
    expect(terminalTabTitle('/')).toBe('/');
    expect(terminalTabTitle(null)).toBe('~');
  });
});

describe('newTerminalFolder', () => {
  const state = run(
    { type: 'open-tab', key: 'a', cwd: '/work/app' },
    { type: 'open-tab', key: 'b', cwd: '/work/site' },
    { type: 'select', key: 'a' },
  );

  it('opens beside the open chat first', () => {
    expect(newTerminalFolder('/work/chat', state)).toBe('/work/chat');
  });

  it('opens beside the tab on screen when no chat is open', () => {
    expect(newTerminalFolder(null, state)).toBe('/work/app');
  });

  it('opens at home with neither', () => {
    expect(newTerminalFolder(null, INITIAL_TERMINAL_TABS)).toBeNull();
  });
});
