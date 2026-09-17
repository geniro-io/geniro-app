import { describe, expect, it } from 'vitest';

import {
  INITIAL_TERMINAL_TABS,
  MAX_TERMINAL_TAB_NAME,
  newTerminalFolder,
  terminalTabLabel,
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
      tabs: [
        { key: 'a', cwd: '/proj', name: null, color: null, exitCode: null },
      ],
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

describe('naming and colouring a tab', () => {
  const two = run(
    { type: 'open-tab', key: 'a', cwd: '/work/app' },
    { type: 'open-tab', key: 'b', cwd: '/work/site' },
  );

  it('names one tab, trimmed, and leaves the others alone', () => {
    const state = terminalTabsReducer(two, {
      type: 'rename',
      key: 'a',
      name: '  dev server ',
    });

    expect(state.tabs.map((tab) => terminalTabLabel(tab))).toEqual([
      'dev server',
      'site',
    ]);
  });

  it('gives a tab its folder name back when renamed to nothing', () => {
    const named = terminalTabsReducer(two, {
      type: 'rename',
      key: 'a',
      name: 'dev server',
    });
    const cleared = terminalTabsReducer(named, {
      type: 'rename',
      key: 'a',
      name: '   ',
    });

    expect(cleared.tabs[0]!.name).toBeNull();
    expect(terminalTabLabel(cleared.tabs[0]!)).toBe('app');
  });

  it('cuts a name past the limit', () => {
    const state = terminalTabsReducer(two, {
      type: 'rename',
      key: 'a',
      name: 'x'.repeat(MAX_TERMINAL_TAB_NAME + 20),
    });

    expect(state.tabs[0]!.name).toHaveLength(MAX_TERMINAL_TAB_NAME);
  });

  it('trims BEFORE cutting, so leading spaces never cost the name its end', () => {
    const name = `  ${'x'.repeat(MAX_TERMINAL_TAB_NAME - 1)}y`;

    const state = terminalTabsReducer(two, { type: 'rename', key: 'a', name });

    expect(state.tabs[0]!.name).toBe(
      `${'x'.repeat(MAX_TERMINAL_TAB_NAME - 1)}y`,
    );
  });

  it("sets and clears one tab's colour", () => {
    const colored = terminalTabsReducer(two, {
      type: 'recolor',
      key: 'b',
      color: 'green',
    });
    const cleared = terminalTabsReducer(colored, {
      type: 'recolor',
      key: 'b',
      color: null,
    });

    expect(colored.tabs.map((tab) => tab.color)).toEqual([null, 'green']);
    expect(cleared.tabs.map((tab) => tab.color)).toEqual([null, null]);
  });
});
