import type { MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../shared/contracts';
import { applicationMenuTemplate } from './app-menu';

const mocks = vi.hoisted(() => ({
  sent: [] as string[],
  focused: null as { webContents: { send: (channel: string) => void } } | null,
}));

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined },
  BrowserWindow: { getFocusedWindow: () => mocks.focused },
}));

/**
 * The template only — `Menu` cannot be built outside a running Electron app,
 * which is why the decisions live in a pure function (the same split, and the
 * same reason, as `context-menu.ts`).
 */

const viewSubmenu = (): MenuItemConstructorOptions[] => {
  const view = applicationMenuTemplate().find((item) => item.label === 'View');
  if (!view || !Array.isArray(view.submenu)) {
    throw new Error('the template has no View submenu');
  }
  return view.submenu;
};

beforeEach(() => {
  mocks.sent.length = 0;
  mocks.focused = null;
});

describe('applicationMenuTemplate', () => {
  it('shows no developer-tools row in the menu bar', () => {
    // The report. Electron's default View menu opens with Reload, Force Reload
    // and Toggle Developer Tools; only the third one goes.
    const shown = viewSubmenu().filter((item) => item.visible !== false);

    expect(shown.map((item) => item.role)).not.toContain('toggleDevTools');
  });

  it('keeps ⌥⌘I working by hiding that row rather than dropping it', () => {
    // Hidden and not deleted, which is a different thing: Electron leaves a
    // hidden item's accelerator registered on macOS, so the inspector stays one
    // chord away for whoever is building the app. Asserted as "present AND
    // invisible" — either half alone is a different feature.
    const devTools = viewSubmenu().find(
      (item) => item.role === 'toggleDevTools',
    );

    expect(devTools).toBeDefined();
    expect(devTools?.visible).toBe(false);
    // Never spelled out here: the role carries the platform's own accelerator,
    // and a literal would be this test restating a string it wrote itself.
    expect(devTools?.accelerator).toBeUndefined();
  });

  it('restates the rest of the default menu rather than inventing one', () => {
    // The four halves that do not change are role menus, so they keep the
    // platform's labels, accelerators and behaviour for free — a hand-built
    // Edit menu is how Paste and Match Style or the Speech submenu go missing.
    expect(applicationMenuTemplate().map((item) => item.role)).toEqual([
      'appMenu',
      'fileMenu',
      'editMenu',
      undefined, // View — spelled out, being the one that changes
      'windowMenu',
    ]);
    // And View itself still offers everything the default did, in order, with
    // this app's own row identified by its label — so an added entry has to be
    // stated here rather than sliding in unnoticed.
    expect(
      viewSubmenu().map((item) => item.role ?? item.type ?? item.label),
    ).toEqual([
      'reload',
      'forceReload',
      'Clear Agent Cache',
      'toggleDevTools',
      'separator',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'separator',
      'togglefullscreen',
    ]);
  });

  it('offers Clear Agent Cache beside the reloads, with no accelerator', () => {
    // ASKED FOR as a menu-bar row ("на мыши нужно сделать сброс кэша"). It sits
    // with the Reloads because it is the same act one layer down — Reload drops
    // what the window holds, this drops what the daemon holds about the CLIs.
    // No accelerator: every other row here carries the platform's own, and an
    // invented chord for a maintenance action is one pressed by accident.
    // ONE template, because each call builds a fresh one — comparing a row
    // from one against the positions of another is a test that passes for the
    // wrong reason.
    const submenu = viewSubmenu();
    const row = submenu.find((item) => item.label === 'Clear Agent Cache');

    expect(row).toBeDefined();
    expect(row?.accelerator).toBeUndefined();
    expect(submenu.indexOf(row!)).toBe(2);
  });

  it('sends the reset to the FOCUSED window, and does nothing without one', () => {
    // The window whose menu bar was clicked, never a broadcast: a second window
    // would clear its caches and flash a confirmation nobody asked for. With no
    // window at all the row is still reachable, and the work belongs to a
    // renderer — so it must not throw.
    const row = viewSubmenu().find(
      (item) => item.label === 'Clear Agent Cache',
    );

    mocks.focused = null;
    expect(() =>
      row?.click?.(null as never, undefined, null as never),
    ).not.toThrow();
    expect(mocks.sent).toEqual([]);

    mocks.focused = {
      webContents: { send: (channel: string) => mocks.sent.push(channel) },
    };
    row?.click?.(null as never, undefined, null as never);

    expect(mocks.sent).toEqual([IPC.onClearAgentCaches]);
  });
});
