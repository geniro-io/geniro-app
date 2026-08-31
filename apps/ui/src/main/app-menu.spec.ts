import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MenuItemConstructorOptions } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../shared/contracts';
import {
  applicationMenuTemplate,
  COMPONENT_CATALOG_URL,
  installApplicationMenu,
} from './app-menu';

const mocks = vi.hoisted(() => ({
  sent: [] as string[],
  focused: null as { webContents: { send: (channel: string) => void } } | null,
  opened: [] as string[],
  dialogs: [] as string[],
  built: [] as MenuItemConstructorOptions[][],
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9', getName: () => 'Geniro' },
  Menu: {
    // Captured rather than discarded: the `isDev` ternary lives in
    // `installApplicationMenu`, and the template it hands over is the only
    // place that decision is observable.
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      mocks.built.push(template);
      return {};
    },
    setApplicationMenu: () => undefined,
  },
  BrowserWindow: { getFocusedWindow: () => mocks.focused },
  shell: {
    openExternal: (url: string) => {
      mocks.opened.push(url);
      return Promise.resolve();
    },
  },
  dialog: {
    showMessageBox: (options: { message: string }) => {
      mocks.dialogs.push(options.message);
      return Promise.resolve({ response: 0, checkboxChecked: false });
    },
  },
}));

/**
 * The template only — `Menu` cannot be built outside a running Electron app,
 * which is why the decisions live in a pure function (the same split, and the
 * same reason, as `context-menu.ts`).
 */

const APP = { name: 'Geniro', version: '1.48.1' };
const VERSION = APP.version;

const viewSubmenu = (): MenuItemConstructorOptions[] => {
  const view = applicationMenuTemplate(APP).find(
    (item) => item.label === 'View',
  );
  if (!view || !Array.isArray(view.submenu)) {
    throw new Error('the template has no View submenu');
  }
  return view.submenu;
};

/** The first submenu — the one macOS names after the app. */
const appSubmenu = (): MenuItemConstructorOptions[] => {
  const submenu = applicationMenuTemplate(APP)[0]?.submenu;
  if (!Array.isArray(submenu)) {
    throw new Error('the template has no app submenu');
  }
  return submenu;
};

/** The View submenu of a DEV template — the one that carries the catalog row. */
const devViewSubmenu = (): MenuItemConstructorOptions[] => {
  const view = applicationMenuTemplate({
    ...APP,
    componentCatalogUrl: COMPONENT_CATALOG_URL,
  }).find((item) => item.label === 'View');
  if (!view || !Array.isArray(view.submenu)) {
    throw new Error('the template has no View submenu');
  }
  return view.submenu;
};

beforeEach(() => {
  mocks.sent.length = 0;
  mocks.focused = null;
  mocks.opened.length = 0;
  mocks.dialogs.length = 0;
  mocks.built.length = 0;
});

// Not an inline call at the end of each stubbing test: a failed assertion
// throws before it, leaving a stubbed `fetch` for every test after it and
// turning one real failure into a cascade of misleading ones.
afterEach(() => {
  vi.unstubAllGlobals();
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

  it('states the running version in the app menu, as a row nothing can press', () => {
    // The report: the version came OUT of the title bar and belongs here
    // instead. `enabled: false` because there is nothing behind it — a live row
    // promises an action a version does not have.
    // ONE template, for the reason the Clear Agent Cache test states: each call
    // builds a fresh one, so a row from one compared against the positions of
    // another can only ever be absent.
    const submenu = appSubmenu();
    const row = submenu.find((item) =>
      String(item.label ?? '').startsWith('Version'),
    );

    expect(row?.label).toBe(`Version ${VERSION}`);
    expect(row?.enabled).toBe(false);
    // Directly under About, which is the other row about what this app IS.
    expect(submenu.indexOf(row!)).toBe(1);
  });

  it('gives every item something Electron will build — label, role or type', () => {
    // Not a style rule: `Menu.buildFromTemplate` THROWS on an item carrying
    // none of the three ("Invalid template for MenuItem"), and the throw
    // happens inside `installApplicationMenu`, where it aborts the install and
    // leaves Electron's own default menu — dev-tools row included — standing.
    // The first cut of the app submenu shipped with only `submenu` on it and
    // did exactly that in the running app, with every unit test green.
    //
    // Built from the DEV template, which is a superset: the conditionally
    // spread catalog row contributes nothing to the packaged arm, so checking
    // that one would leave the only conditionally-built item unchecked.
    const items = applicationMenuTemplate({
      ...APP,
      componentCatalogUrl: COMPONENT_CATALOG_URL,
    }).flatMap((item) => [
      item,
      ...(Array.isArray(item.submenu) ? item.submenu : []),
    ]);

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(
        item.label !== undefined ||
          item.role !== undefined ||
          item.type !== undefined,
      ).toBe(true);
    }
  });

  it('restates the rest of the default menu rather than inventing one', () => {
    // The three halves that do not change are role menus, so they keep the
    // platform's labels, accelerators and behaviour for free — a hand-built
    // Edit menu is how Paste and Match Style or the Speech submenu go missing.
    expect(applicationMenuTemplate(APP).map((item) => item.role)).toEqual([
      undefined, // the app menu — spelled out for the version row
      'fileMenu',
      'editMenu',
      undefined, // View — spelled out, being the one that changes
      'windowMenu',
    ]);
    // The app menu keeps every row Electron's own `appMenu` role builds, in
    // order, with only the version added — so a role dropped from it (Services,
    // Hide Others) has to be stated here rather than going missing in silence.
    expect(
      appSubmenu().map((item) => item.role ?? item.type ?? item.label),
    ).toEqual([
      'about',
      `Version ${VERSION}`,
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
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

  it('omits the component catalog entirely when no URL is given', () => {
    // Asserted against the whole submenu rather than the row's own `visible`,
    // because "hidden" is what the dev-tools row above does, and absent is the
    // other decision.
    expect(viewSubmenu().map((item) => item.label)).not.toContain(
      'Component Catalog',
    );
  });

  it('offers the component catalog in a dev launch, beside the other View rows', () => {
    const submenu = devViewSubmenu();
    const row = submenu.find((item) => item.label === 'Component Catalog');

    expect(row).toBeDefined();
    // Directly after Clear Agent Cache, which is where the rest of this app's
    // own rows sit. No accelerator, on the rule the row above states.
    expect(submenu.indexOf(row!)).toBe(3);
    expect(row?.accelerator).toBeUndefined();
  });

  it('gates the catalog row on isDev, and opens the URL it was built with', async () => {
    // The template's default parameter is NOT this decision — the ternary in
    // `installApplicationMenu` is, and it is the one a packaged build depends
    // on. Both halves are pinned from the INSTALLED template rather than one
    // this spec composed: presence (a shipped build must not offer the row) and
    // the URL it carries (pointing it at another port must not stay green).
    const catalogRow = (): MenuItemConstructorOptions | undefined => {
      const view = mocks.built.at(-1)?.find((item) => item.label === 'View');
      const submenu = Array.isArray(view?.submenu) ? view.submenu : [];
      return submenu.find((item) => item.label === 'Component Catalog');
    };

    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null)));

    installApplicationMenu({ isDev: true });
    const row = catalogRow();
    expect(row).toBeDefined();

    row?.click?.(null as never, undefined, null as never);
    await vi.waitFor(() =>
      expect(mocks.opened).toEqual([COMPONENT_CATALOG_URL]),
    );

    installApplicationMenu({ isDev: false });
    expect(catalogRow()).toBeUndefined();
  });

  it('serves the catalog at the address the storybook script binds', () => {
    // A TWIN with no importable side: `app-menu.ts` spells the address and so
    // does `package.json`'s `storybook` script, and a package script cannot be
    // imported. Read the script and compare, rather than restating 6006 here —
    // the same shape as `theme-tokens.spec.ts` reading global.css. BOTH halves
    // are derived from the constant, so changing either side alone fails.
    const manifest = readFileSync(
      join(__dirname, '../../package.json'),
      'utf8',
    );
    const script = (JSON.parse(manifest) as { scripts: Record<string, string> })
      .scripts.storybook;
    const { hostname, port } = new URL(COMPONENT_CATALOG_URL);

    expect(script).toBeDefined();
    // Anchored at a boundary: a bare `toContain('-p 6006')` is satisfied by
    // `-p 60061`, which is a different server.
    expect(script).toMatch(new RegExp(`-p ${port}(\\s|$)`));
    // And it binds THAT host — the wildcard default puts the whole workspace on
    // the LAN through Vite's /@fs/ handler, and a `localhost` constant against a
    // v4-only bind fails on an IPv6-first resolver.
    expect(script).toMatch(new RegExp(`--host ${hostname}(\\s|$)`));
  });

  it('opens the catalog when it answers', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null)));
    const row = devViewSubmenu().find(
      (item) => item.label === 'Component Catalog',
    );

    row?.click?.(null as never, undefined, null as never);
    await vi.waitFor(() =>
      expect(mocks.opened).toEqual([COMPONENT_CATALOG_URL]),
    );

    expect(mocks.dialogs).toEqual([]);
  });

  it('gives up on a port that accepts and never answers', async () => {
    // What CATALOG_PROBE_MS is for, and the case no other test reaches:
    // Storybook mid-boot accepts the connection and holds it open.
    //
    // `sawSignal` is what makes this a real pin. Reading `init.signal` inside
    // the executor is NOT enough on its own: with the signal removed from the
    // production call, that read throws, the executor turns the throw into a
    // rejection, and the dialog appears anyway — so the dialog assertion alone
    // passes against the very deletion it claims to catch.
    let sawSignal = false;
    vi.stubGlobal(
      'fetch',
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          sawSignal = init?.signal instanceof AbortSignal;
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const row = devViewSubmenu().find(
      (item) => item.label === 'Component Catalog',
    );

    row?.click?.(null as never, undefined, null as never);
    await vi.waitFor(() => expect(mocks.dialogs).toHaveLength(1), {
      timeout: 5000,
    });

    // Asserted out here, never inside the stub: production catches everything
    // the probe throws, so a failed `expect` in there is swallowed.
    expect(sawSignal).toBe(true);
    expect(mocks.opened).toEqual([]);
  });

  it('says the catalog is not running instead of opening a dead tab', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    const row = devViewSubmenu().find(
      (item) => item.label === 'Component Catalog',
    );

    row?.click?.(null as never, undefined, null as never);
    await vi.waitFor(() => expect(mocks.dialogs).toHaveLength(1));

    // The browser is never reached — which is the whole behaviour being pinned.
    expect(mocks.opened).toEqual([]);
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
