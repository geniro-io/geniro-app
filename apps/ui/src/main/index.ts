import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { app, BrowserWindow, nativeImage, session, shell } from 'electron';

import { notifyDaemonReady } from './daemon-ready-notify';
import { DaemonSupervisor } from './daemon-supervisor';
import { registerIpc } from './ipc';
import { isAllowedTopFrameNavigation } from './navigation-policy';
import { readSettings } from './settings';
import { checkOnLaunch } from './updater';

/**
 * Product display name. Set before anything reads it: it drives
 * `app.getPath('userData')` (settings.json, the daemon pidfile, and the DB all
 * live under `…/Application Support/Geniro`), default menu-item strings, and
 * the About panel. It does NOT rename the dev Dock tile / bold menu-bar title —
 * macOS reads those from the running bundle's Info.plist, so under
 * `electron-vite dev` they say "Electron" until the M4 packaged build
 * (electron-builder `productName`) ships a real Geniro.app.
 */
app.setName('Geniro');
app.setAboutPanelOptions({
  applicationName: 'Geniro',
  applicationVersion: app.getVersion(),
});

/** Absolute path to the app icon (the lightbulb-robot mascot). */
const ICON_PATH = join(app.getAppPath(), 'resources', 'icon.png');

/** True under `electron-vite dev` (renderer served from a URL, not a file). */
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

const supervisor = new DaemonSupervisor();
let mainWindow: BrowserWindow | null = null;
let teardownDone = false;

/**
 * Schemes we hand off to the OS browser. Anything else (file:, custom app
 * schemes) is refused — shell.openExternal on untrusted input can be coerced
 * into running arbitrary commands (Electron security checklist #14).
 */
const EXTERNAL_OPEN_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

/** URL scheme (e.g. 'https:'), or '' when `url` doesn't parse. */
function schemeOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

/** The unpacked DevTools extension that adds the "Geniro" panel. */
const DEVTOOLS_EXTENSION_PATH = join(
  app.getAppPath(),
  'resources',
  'devtools-extension',
);

/**
 * Register the Geniro panel inside Chrome DevTools.
 *
 * This is what makes the daemon's log a REAL DevTools tab — beside Elements,
 * Console and Network, following the user's DevTools theme — rather than a
 * panel of ours that merely resembles one. The renderer's own drawer stays: it
 * is the surface you consult while USING the app, and it is the only one
 * available when DevTools is closed.
 *
 * Loaded on every boot by design — Electron stopped remembering extensions
 * across runs — and into the DEFAULT session, which is the one the window
 * uses. A failure is logged and swallowed: an absent debug tab must never be
 * the reason the app does not start, and Electron supports only a subset of
 * the extension APIs, so this is the kind of thing that can break under an
 * Electron upgrade.
 */
async function loadDevToolsExtension(): Promise<void> {
  if (!existsSync(DEVTOOLS_EXTENSION_PATH)) {
    return;
  }
  try {
    await session.defaultSession.extensions.loadExtension(
      DEVTOOLS_EXTENSION_PATH,
    );
  } catch (err) {
    console.error('failed to load the Geniro DevTools panel', err);
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    // Keep the builder's palette + canvas + inspector (and the library grid)
    // usable — below this the three-pane layout starts to crowd.
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Geniro',
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Renderer runs sandboxed; the preload only uses `electron`, so nothing
      // here needs an unsandboxed context.
      sandbox: true,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  win.on('ready-to-show', () => win.show());

  // Open external links in the user's browser, never in-app — and only for
  // web/mail schemes, so a compromised renderer can't hand file:// or a custom
  // app scheme to the OS opener.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_OPEN_SCHEMES.has(schemeOf(url))) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Pin the top frame to its own origin. The renderer is a local SPA (its
  // client-side routing uses history/hash, which doesn't fire these events), so
  // any full navigation to another origin is unexpected and refused.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedTopFrameNavigation(url, win.webContents.getURL())) {
      event.preventDefault();
    }
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedTopFrameNavigation(url, win.webContents.getURL())) {
      event.preventDefault();
    }
  });

  // electron-vite sets ELECTRON_RENDERER_URL in dev; otherwise load the build.
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * Bring the daemon up and hand the renderer its address.
 *
 * The one entry point for both the launch and a later re-ensure, so the window
 * always learns about a daemon the same way: a failure is surfaced but never
 * fatal — the renderer shows a disconnected state rather than the app failing
 * to open.
 */
function ensureDaemon(): void {
  void supervisor
    .start()
    .then((handle) => notifyDaemonReady(mainWindow, handle))
    .catch((err: unknown) => {
      console.error('[ui] daemon failed to start:', err);
    });
}

function focusMainWindow(): void {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

function main(): void {
  // The app is the single owner of the daemon and its pidfile. A second launch
  // focuses the existing window instead of double-spawning the daemon and
  // clobbering the shared pidfile. macOS already enforces single-instance for
  // Finder/Dock launches; this lock additionally covers CLI/dev relaunches.
  app.on('second-instance', focusMainWindow);

  void app.whenReady().then(async () => {
    // In dev the Dock shows Electron's default icon; override it with the Geniro
    // mascot. A packaged build gets its icon from the bundled .icns (M4), so this
    // only runs under `electron-vite dev`.
    if (
      isDev &&
      process.platform === 'darwin' &&
      app.dock &&
      existsSync(ICON_PATH)
    ) {
      app.dock.setIcon(nativeImage.createFromPath(ICON_PATH));
    }

    registerIpc(supervisor);
    checkOnLaunch(readSettings().checkForUpdates);
    await loadDevToolsExtension();

    // Open the window FIRST and let the daemon boot in parallel: first paint
    // and the renderer bundle load overlap the spawn + health poll instead of
    // trailing them (the renderer shows "Connecting to the daemon…" and
    // subscribes to onDaemonRestarted before its initial status fetch, so
    // both ready-vs-mount orderings deliver the handle).
    createWindow();

    ensureDaemon();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
      // The daemon may be gone even though the app is not: on macOS, closing
      // the window leaves the app in the Dock with no client attached, and the
      // daemon exits itself once its idle window passes. Coming back through
      // the Dock has to bring it back, or the reopened window would talk to a
      // handle that no longer answers. `start()` de-dupes concurrent calls and
      // adopts a healthy daemon, so an unnecessary call here costs nothing.
      if (!supervisor.isConnected()) {
        ensureDaemon();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Tear the owned daemon down cleanly before the app exits.
  app.on('before-quit', (event) => {
    if (teardownDone) {
      return;
    }
    event.preventDefault();
    void supervisor.stop().finally(() => {
      teardownDone = true;
      app.quit();
    });
  });
}

if (app.requestSingleInstanceLock()) {
  main();
} else {
  // Another instance already owns the daemon; the running one is focused via
  // its 'second-instance' handler, so this one exits immediately.
  app.quit();
}
