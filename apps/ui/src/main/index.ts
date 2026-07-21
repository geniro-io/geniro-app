import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { app, BrowserWindow, nativeImage, shell } from 'electron';

import { IPC } from '../shared/contracts';
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

    // Open the window FIRST and let the daemon boot in parallel: first paint
    // and the renderer bundle load overlap the spawn + health poll instead of
    // trailing them (the renderer shows "Connecting to the daemon…" and
    // subscribes to onDaemonRestarted before its initial status fetch, so
    // both ready-vs-mount orderings deliver the handle).
    createWindow();

    void supervisor
      .start()
      .then((handle) => {
        mainWindow?.webContents.send(IPC.onDaemonRestarted, handle);
      })
      .catch((err: unknown) => {
        // Surface the failure but keep the window — the renderer renders a
        // disconnected state rather than the app failing to launch.
        console.error('[ui] daemon failed to start:', err);
      });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
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
