// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalPanel } from './terminal-panel';
import type { TerminalEnding } from './terminal-view';
import { type TerminalTabs, useTerminalTabs } from './use-terminal-tabs';

const views = vi.hoisted(() => ({
  ends: new Map<string | null, (ending: TerminalEnding) => void>(),
}));

// The emulator itself is covered by terminal-view.spec; here a stand-in records
// what each tab was handed and lets a test end its shell.
vi.mock('./terminal-view', () => ({
  default: ({
    cwd,
    shown,
    onEnded,
  }: {
    cwd: string | null;
    shown: boolean;
    onEnded: (ending: TerminalEnding) => void;
  }) => {
    views.ends.set(cwd, onEnded);
    return (
      <div data-testid="view" data-cwd={cwd ?? ''} data-shown={String(shown)} />
    );
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  views.ends.clear();
});

async function mount(
  seed: (tabs: TerminalTabs) => void,
): Promise<{ container: HTMLElement; tabs: () => TerminalTabs }> {
  let latest: TerminalTabs | null = null;
  const onNewTab = vi.fn();
  function Harness(): React.JSX.Element {
    const tabs = useTerminalTabs();
    latest = tabs;
    useEffect(() => {
      seed(tabs);
      // Seeded once, like a user's first presses.
    }, []);
    return <TerminalPanel terminals={tabs} onNewTab={onNewTab} />;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness />);
  });
  // Resolves the lazy view.
  await act(async () => {
    await Promise.resolve();
  });
  return { container, tabs: () => latest! };
}

function tabButtons(container: HTMLElement): HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Terminals"] button[aria-pressed]',
    ),
  ];
}

describe('TerminalPanel', () => {
  it('draws a tab per shell and shows only the selected one', async () => {
    const { container } = await mount((tabs) => {
      tabs.openTab('/work/app');
      tabs.openTab('/work/site');
    });

    expect(tabButtons(container).map((tab) => tab.textContent)).toEqual([
      'app',
      'site',
    ]);
    expect(
      tabButtons(container).map((tab) => tab.getAttribute('aria-pressed')),
    ).toEqual(['false', 'true']);
    const shown = [
      ...container.querySelectorAll<HTMLElement>('[data-testid="view"]'),
    ].map((view) => [view.dataset.cwd, view.dataset.shown]);
    expect(shown).toEqual([
      ['/work/app', 'false'],
      ['/work/site', 'true'],
    ]);

    await act(async () => tabButtons(container)[0]!.click());
    expect(
      tabButtons(container).map((tab) => tab.getAttribute('aria-pressed')),
    ).toEqual(['true', 'false']);
  });

  it('ends a shell when its tab is closed', async () => {
    const { container, tabs } = await mount((t) => {
      t.openTab('/work/app');
      t.openTab('/work/site');
    });

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Close terminal app"]',
        )!
        .click(),
    );

    expect(tabs().tabs.map((tab) => tab.cwd)).toEqual(['/work/site']);
    expect(container.querySelectorAll('[data-testid="view"]')).toHaveLength(1);
  });

  it('hides the panel without unmounting a single shell', async () => {
    const { container } = await mount((t) => t.openTab('/work/app'));

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Hide the terminal panel"]',
        )!
        .click(),
    );

    expect(
      container.querySelector('aside[aria-label="Terminal"]')?.className,
    ).toContain('hidden');
    const view = container.querySelector<HTMLElement>('[data-testid="view"]');
    expect(view).not.toBeNull();
    expect(view?.dataset.shown).toBe('false');
  });

  it('closes a tab whose shell exited after use, whatever its code', async () => {
    const { tabs } = await mount((t) => {
      t.openTab('/work/app');
      t.openTab('/work/site');
    });

    await act(async () =>
      views.ends.get('/work/app')!({
        kind: 'exited',
        exitCode: 0,
        signal: null,
        used: true,
      }),
    );
    // A bare `exit` after a failed command returns that command's status.
    await act(async () =>
      views.ends.get('/work/site')!({
        kind: 'exited',
        exitCode: 1,
        signal: null,
        used: true,
      }),
    );

    expect(tabs().tabs).toEqual([]);
  });

  it('keeps a tab whose shell was killed, or never started', async () => {
    const { tabs } = await mount((t) => {
      t.openTab('/work/app');
      t.openTab('/gone');
    });

    await act(async () =>
      views.ends.get('/work/app')!({
        kind: 'exited',
        exitCode: 0,
        signal: 9,
        used: true,
      }),
    );
    await act(async () =>
      views.ends.get('/gone')!({ kind: 'failed-to-start' }),
    );

    expect(tabs().tabs).toEqual([
      expect.objectContaining({ cwd: '/work/app', exitCode: 0 }),
      expect.objectContaining({ cwd: '/gone', exitCode: 1 }),
    ]);
  });

  it('keeps a tab whose shell exited before any input, so a broken login rc stays readable', async () => {
    const { tabs } = await mount((t) => t.openTab('/work/app'));

    await act(async () =>
      views.ends.get('/work/app')!({
        kind: 'exited',
        exitCode: 1,
        signal: null,
        used: false,
      }),
    );

    expect(tabs().tabs).toEqual([
      expect.objectContaining({ cwd: '/work/app', exitCode: 1 }),
    ]);
  });

  it('renders nothing until the first tab exists', async () => {
    const { container } = await mount(() => undefined);

    expect(container.querySelector('aside[aria-label="Terminal"]')).toBeNull();
  });

  it('colours a tab from its options menu, and takes the colour off again', async () => {
    const { container, tabs } = await mount((t) => t.openTab('/work/app'));

    await act(async () => optionsButton(container, 'app').click());
    await act(async () => menuRow('Green').click());

    expect(tabs().tabs[0]!.color).toBe('green');
    expect(optionsButton(container, 'app').querySelector('svg')).toBeNull();
    expect(
      container
        .querySelector('[data-slot="terminal-tab-color"]')
        ?.getAttribute('data-color'),
    ).toBe('green');

    await act(async () => optionsButton(container, 'app').click());
    await act(async () => menuRow('No colour').click());

    expect(tabs().tabs[0]!.color).toBeNull();
    expect(optionsButton(container, 'app').querySelector('svg')).not.toBeNull();
    expect(
      container.querySelector('[data-slot="terminal-tab-color"]'),
    ).toBeNull();
  });

  it('renames a tab from its menu, committing on Enter', async () => {
    const { container, tabs } = await mount((t) => t.openTab('/work/app'));

    await act(async () => optionsButton(container, 'app').click());
    await act(async () => menuRow('Rename tab…').click());
    const field = container.querySelector<HTMLInputElement>(
      'input[aria-label="Rename terminal app"]',
    )!;
    await act(async () => {
      setInputValue(field, 'dev server');
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(tabs().tabs[0]!.name).toBe('dev server');
    expect(tabButtons(container).map((tab) => tab.textContent)).toEqual([
      'dev server',
    ]);
  });

  it('renames on double-click, and Escape keeps the old name', async () => {
    const { container, tabs } = await mount((t) => t.openTab('/work/app'));

    await act(async () =>
      tabButtons(container)[0]!.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      ),
    );
    const field = container.querySelector<HTMLInputElement>(
      'input[aria-label="Rename terminal app"]',
    )!;
    expect(field).not.toBeNull();
    await act(async () => {
      setInputValue(field, 'abandoned');
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(tabs().tabs[0]!.name).toBeNull();
    expect(
      container.querySelector('input[aria-label="Rename terminal app"]'),
    ).toBeNull();
  });
});

function optionsButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="Options for terminal ${label}"]`,
  )!;
}

function menuRow(label: string): HTMLElement {
  const row = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent?.includes(label));
  if (!row) {
    throw new Error(`no menu row "${label}"`);
  }
  return row;
}

/** React tracks an input's value itself; set it the way a keystroke would. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
