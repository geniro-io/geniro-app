import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  shell,
} from 'electron';

import { IPC } from '../shared/contracts';

/**
 * Where `pnpm storybook` serves the component catalog.
 *
 * TWIN: the host and port are spelled here and in `apps/ui/package.json`'s
 * `storybook` script (`storybook dev -p 6006 --host 127.0.0.1`). Nothing can
 * read one from the other — a package script is not importable — so
 * `app-menu.spec.ts` reads that script and asserts the two agree.
 *
 * `127.0.0.1` rather than `localhost`, matching the bind exactly: that script
 * binds v4 loopback only, and on an IPv6-first resolver `localhost` resolves to
 * `::1`, where nothing would be listening. The bind is not negotiable — the
 * wildcard default serves the whole workspace over the LAN through Vite's
 * `/@fs/` handler, in an app whose own daemon binds loopback only.
 */
export const COMPONENT_CATALOG_URL = 'http://127.0.0.1:6006';

/** How long to wait for the catalog to answer before saying it is not up. */
const CATALOG_PROBE_MS = 1500;

/**
 * The macOS menu bar — Electron's own default, minus the one entry that is
 * about debugging this app rather than using it.
 *
 * Without a call to `Menu.setApplicationMenu` Electron builds a default menu,
 * and its View submenu opens with Reload, Force Reload and **Toggle Developer
 * Tools**. That last one was REPORTED ("давай уберем вот эту вот кнопочку
 * дебага… в меню приложения") and it is the whole reason this file exists: a
 * menu bar is the app's most public surface, and a row that opens Chromium's
 * inspector belongs to whoever is building the app, not to whoever is using it.
 *
 * So the template restates the default rather than inventing one — three role
 * menus (`fileMenu`/`editMenu`/`windowMenu`) reproduce their halves byte for
 * byte, with the platform's own labels and accelerators, and only the two that
 * CHANGE are spelled out. Dumped from a probe Electron before writing it, so
 * this is a copy of what shipped rather than of the docs.
 *
 * The app menu is spelled out for one added row: the running version, REPORTED
 * out of the title bar and asked for here instead ("давай уберем полностью
 * оттуда версию и берём её в меню приложения, там, где Geniro файл edit you
 * window"). Every other row stays a role, so only the version readout is this
 * file's own words. It is `enabled: false` because there is nothing to press —
 * a version is a fact, and a live row would promise an action behind it.
 *
 * macOS only, like the app.
 */
export function applicationMenuTemplate({
  name,
  version,
  componentCatalogUrl = null,
}: {
  /** What macOS calls this app — electron-builder's `productName`. */
  name: string;
  /** The running build, for the row the title bar gave up. */
  version: string;
  /**
   * Where the component catalog is served, or null to omit its row entirely.
   *
   * Null in every packaged build: Storybook is a development dependency that is
   * never bundled, so a shipped app offering the row would offer a link to a
   * port nothing on the user's machine is listening on. Omitted rather than
   * disabled — a greyed row states that a feature exists and is unavailable,
   * which is true for a developer and simply wrong for everyone else.
   */
  componentCatalogUrl?: string | null;
}): MenuItemConstructorOptions[] {
  return [
    {
      // macOS names the first submenu after the app whatever this says, so the
      // label is cosmetically irrelevant — and Electron REFUSES a template item
      // carrying none of label/role/type, which is how the first cut of this
      // menu threw at install and left the default menu (dev-tools row and all)
      // in place. Read from the app rather than written out, so the one place
      // the name could drift from `productName` does not exist.
      label: name,
      submenu: [
        { role: 'about' },
        { label: `Version ${version}`, enabled: false },
        { type: 'separator' },
        { role: 'services', submenu: [] },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        // Beside the two Reloads because it is the same act one layer down:
        // Reload throws away what the WINDOW holds, this throws away what the
        // DAEMON holds about the CLIs — their models, the settings each model
        // offers, the MCP servers a folder loads. ASKED FOR as "на мыши нужно
        // сделать сброс кэша… как дополнительную функцию" against a menu bar
        // that had no such row.
        //
        // No accelerator: every other row here has the platform's own, and
        // inventing one for a maintenance action is how a chord comes to be
        // pressed by accident.
        {
          label: 'Clear Agent Cache',
          click: () => sendToFocusedWindow(IPC.onClearAgentCaches),
        },
        // Development only — see `componentCatalogUrl` above. Spread so the row
        // is ABSENT rather than present-and-falsy: `buildFromTemplate` throws on
        // an item carrying none of label/role/type, which is what a bare
        // `condition && {...}` would hand it.
        ...(componentCatalogUrl === null
          ? []
          : [
              {
                label: 'Component Catalog',
                click: () => {
                  void openComponentCatalog(componentCatalogUrl);
                },
              } satisfies MenuItemConstructorOptions,
            ]),
        // HIDDEN, not deleted. The report is about the menu, and a hidden item
        // is not in the menu — while Electron keeps its accelerator registered
        // (`acceleratorWorksWhenHidden` defaults to true on macOS), so ⌥⌘I goes
        // on opening the inspector for anyone who knows to press it. Deleting
        // the row would leave the debug panel's own DevTools button as the only
        // way in, which is two chords deep now that the title bar's trigger is
        // gone as well.
        { role: 'toggleDevTools', visible: false },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
}

/**
 * Hand one menu press to the window the user is actually looking at.
 *
 * The FOCUSED window and not every window: a menu row acts on the window whose
 * menu bar was clicked, and broadcasting would have a second window clear its
 * caches and flash a confirmation nobody asked for. Silently does nothing when
 * there is none — a menu is reachable while every window is closed, and the
 * work belongs to a renderer.
 */
function sendToFocusedWindow(channel: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(channel);
}

/**
 * Open the catalog in the user's browser, or say why it cannot be.
 *
 * The probe is the whole point of this not being a bare `openExternal`: the
 * catalog is a separate dev server this app neither starts nor supervises, so
 * the common case on a fresh `pnpm dev` is that nothing is listening — and a
 * browser tab reading ERR_CONNECTION_REFUSED names no way forward. Spawning
 * Storybook instead was considered and rejected: it is a long-lived child this
 * process would then own the lifecycle of, for a convenience a one-line
 * message buys.
 */
async function openComponentCatalog(url: string): Promise<void> {
  let listening = true;
  try {
    await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(CATALOG_PROBE_MS),
    });
  } catch {
    listening = false;
  }

  // A failed hand-off is not a silent one: the dialog has not been used yet on
  // this branch, so it is still available to say what happened. Tracked apart
  // from `listening` because the two are different failures and the user is
  // told which — a server that never answered, or a browser that would not open.
  let handoffFailed = false;
  if (listening) {
    try {
      await shell.openExternal(url);
      return;
    } catch {
      handoffFailed = true;
    }
  }

  // Total by construction: the caller can only `void` this, so a rejection
  // escaping it reaches Electron's uncaught-exception dialog — a "JavaScript
  // error in the main process" popup raised by a menu click. Swallowed here
  // because the dialog IS the last channel; there is nothing left to report a
  // failed report with.
  try {
    await dialog.showMessageBox({
      type: 'info',
      message: handoffFailed
        ? 'The component catalog could not be opened.'
        : 'The component catalog is not running.',
      detail: handoffFailed
        ? `It is running — open ${url} in your browser.`
        : `Start it with \`pnpm storybook\`, then open ${url}.`,
      buttons: ['OK'],
    });
  } catch {
    // Nothing further to try.
  }
}

/** Replace Electron's default menu with {@link applicationMenuTemplate}. */
export function installApplicationMenu({
  isDev,
}: {
  /**
   * Whether this launch is a development one — `main/index.ts` reads it from
   * `ELECTRON_RENDERER_URL`, the signal it already uses for renderer-adjacent
   * gating. Passed in rather than read here so the template stays a pure
   * function of its arguments, which is what makes both arms spec-testable.
   */
  isDev: boolean;
}): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate({
        componentCatalogUrl: isDev ? COMPONENT_CATALOG_URL : null,
        name: app.getName(),
        // The same reading the About panel above this row and the updater's
        // `currentVersion` already take, so the three cannot disagree. Under a
        // DEV launch it is Electron's own version — there is no app bundle to
        // read one from — which is why the row is read off the packaged app
        // when it is checked.
        version: app.getVersion(),
      }),
    ),
  );
}
