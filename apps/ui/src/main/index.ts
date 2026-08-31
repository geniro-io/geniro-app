import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { app, BrowserWindow, nativeImage, session, shell } from 'electron';

import { TRAFFIC_LIGHT_INSET } from '../shared/contracts';
import { themeWindowBackground } from '../shared/themes';
import { installApplicationMenu } from './app-menu';
import { installContextMenu } from './context-menu';
import { notifyDaemonReady } from './daemon-ready-notify';
import { DaemonSupervisor } from './daemon-supervisor';
import { registerIpc } from './ipc';
import {
  applyTheme,
  resolvedTheme,
  watchSystemAppearance,
} from './native-appearance';
import { isAllowedTopFrameNavigation } from './navigation-policy';
import { purgeLegacySecret } from './purge-legacy-secret';
import { readSettings } from './settings';
import { createUpdateService } from './update-service';
import {
  describeLoadFailure,
  flushMainLogs,
  isRealLoadFailure,
  reportMainLog,
} from './window-diagnostics';

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

/**
 * Run this build against a userData directory of its OWN.
 *
 * `app.setName` above is what makes every build — dev and installed alike —
 * resolve the SAME `…/Application Support/Geniro`, which is normally right:
 * a developer wants their real chats. It is exactly wrong when both are meant
 * to run at once. The daemon allows one instance per userData directory, so
 * the second launch cannot start its own; and `DaemonSupervisor` deliberately
 * leaves a daemon started from a different entry path alone, so the dev shell
 * ADOPTS the installed app's daemon and every daemon-side change under test
 * silently is not the code being exercised.
 *
 * Naming a directory here separates the two completely — settings, database,
 * pidfile, instance lock, attachments and logs — so a dev build can be driven
 * beside an installed one without either noticing. Unset, nothing changes.
 *
 * It must be applied BEFORE anything reads a path, which is why it sits here
 * rather than in `main()`: `readSettings` and the supervisor both resolve
 * `userData` at their first call.
 */
const userDataOverride = process.env.GENIRO_UI_USER_DATA?.trim();
if (userDataOverride) {
  app.setPath('userData', userDataOverride);
  // Session storage (cookies, cache, DevTools state) follows userData, so a
  // second shell would otherwise still share the installed app's — and Chromium
  // takes a lock on it, which is a launch failure rather than a subtle one.
  app.setPath('sessionData', userDataOverride);
}

/** Absolute path to the app icon (the lightbulb-robot mascot). */
const ICON_PATH = join(app.getAppPath(), 'resources', 'icon.png');

/** True under `electron-vite dev` (renderer served from a URL, not a file). */
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

const supervisor = new DaemonSupervisor();
// The update service's own reporting channel. Everything it knew used to go to
// `console`, and a packaged Finder launch discards main's stdout — so a wedged
// or failed update left no record anywhere. `reportMainLog` buffers until the
// daemon exists, which covers the launch sweep below firing before it does.
const updates = createUpdateService((level, message, context) => {
  void reportMainLog(supervisor.getHandle(), level, message, context);
});
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
  // Asked, not applied: `themeSource` is already current (set at launch and by
  // every theme change), so this path only needs to KNOW what is being painted.
  // It runs on macOS `activate` too, which can reopen a window long after the
  // theme was last changed.
  const theme = resolvedTheme(readSettings().theme);
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    // Keep the builder's palette + canvas + inspector (and the library grid)
    // usable — below this the three-pane layout starts to crowd.
    minWidth: 960,
    minHeight: 640,
    show: false,
    // The ground the window paints where the page has not (yet). Unset it is
    // WHITE — see {@link ThemeDescriptor.windowBackground} for the band that
    // produced, and why it is per-theme.
    backgroundColor: themeWindowBackground(theme),
    title: 'Geniro',
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    /**
     * The app draws its own title bar — the shape Chrome and Cursor use.
     *
     * `hiddenInset` removes the system's strip while KEEPING the traffic
     * lights, which is the whole point: the band the OS drew held nothing but
     * the word "Geniro" directly above a row of ours that already named the
     * open chat, so the window spent ~28px saying something it said again
     * underneath. `frame: false` would take the lights with it and leave the
     * app owing the user three buttons it would have to draw and wire itself.
     *
     * The lights are positioned INTO the nav rail's own top row (see
     * `components/nav-rail.tsx`, which reserves the width) rather than left at
     * the default inset, because that default assumes a title bar's height and
     * ours is the rail's. Both values are macOS-only and ignored elsewhere.
     *
     * The inset is SHARED with the renderer rather than spelled here, because
     * placing the buttons and leaving room for them are two halves of one
     * fact — see `TRAFFIC_LIGHT_INSET` in `shared/contracts.ts`.
     */
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHT_INSET,
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
  // Electron ships no right-click menu of its own, so without this every
  // right-click in the app does nothing — see `context-menu.ts`.
  installContextMenu(win.webContents);
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
  const load = (): void => {
    if (rendererUrl) {
      void win.loadURL(rendererUrl);
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'));
    }
  };

  /**
   * Say what this window actually loaded, and retry ONCE if it loaded nothing.
   *
   * A user reopened the app through the Dock and got a window rendering raw
   * bytes in the browser's default serif — no app, no stylesheet, nothing to
   * click. It could not be diagnosed afterwards, and the reason is structural:
   * the `ui` log channel is fed only by the RENDERER's own error handlers, so a
   * window where the renderer never ran reports nothing by construction, and
   * the main process — the one party that can see a load commit — had no path
   * into the log at all. Across every log file on that machine the channel held
   * zero entries.
   *
   * `did-finish-load` records the URL the window COMMITTED rather than the one
   * it was asked for, which is the question a reader actually has. It is
   * deliberately not a health check on the document: from here that would need
   * `executeJavaScript` against the page's own CSP, and a wrong answer would
   * reload a working app under the user.
   *
   * The retry is only for a REAL failure — `ERR_ABORTED` is what an ordinary
   * redirect or an HMR reload looks like — and only once, because a second
   * identical failure is a broken install rather than a transient, and a window
   * that reloads forever is worse than one that stops with a line in the log.
   */
  let failures = 0;
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, url, isMainFrame) => {
      const failure = { errorCode, errorDescription, url, isMainFrame };
      if (!isRealLoadFailure(failure)) {
        return;
      }
      const retrying = failures === 0;
      failures += 1;
      void reportMainLog(
        supervisor.getHandle(),
        'error',
        describeLoadFailure(failure),
        { kind: 'renderer-load-failed', retrying: String(retrying) },
      );
      if (retrying) {
        load();
      }
    },
  );
  win.webContents.on('render-process-gone', (_event, details) => {
    void reportMainLog(
      supervisor.getHandle(),
      'error',
      `the renderer process is gone: ${details.reason}`,
      { kind: 'render-process-gone', exitCode: String(details.exitCode) },
    );
  });
  win.webContents.on('did-finish-load', () => {
    // Worded off the failure count rather than reported as a plain success,
    // because this fires for Chromium's ERROR PAGE too — and it keeps the
    // failed URL, so the two are indistinguishable from here. Measured against
    // a dead renderer URL, the naive line read "the window loaded
    // http://127.0.0.1:59999/" directly beneath "ERR_CONNECTION_REFUSED",
    // which is the log contradicting itself about the same load.
    void reportMainLog(
      supervisor.getHandle(),
      'info',
      failures === 0
        ? `the window loaded ${win.webContents.getURL()}`
        : `the window finished loading ${win.webContents.getURL()} after ${failures} failed attempt(s) — this may be the browser's error page`,
      { kind: 'renderer-loaded', failures: String(failures) },
    );
  });

  load();
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
    .then((handle) => {
      notifyDaemonReady(mainWindow, handle);
      // The window is opened BEFORE this, so whatever it already reported about
      // its own load has been waiting for an address to send it to.
      void flushMainLogs(handle);
    })
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
  // Unconditional, not gated behind whenReady or any settings flag — see
  // purge-legacy-secret.ts for why that is both safe and the point.
  purgeLegacySecret();

  // The app is the single owner of the daemon and its pidfile. A second launch
  // focuses the existing window instead of double-spawning the daemon and
  // clobbering the shared pidfile. macOS already enforces single-instance for
  // Finder/Dock launches; this lock additionally covers CLI/dev relaunches.
  app.on('second-instance', focusMainWindow);

  void app.whenReady().then(async () => {
    // Before the window, and before the menu: it decides how macOS draws every
    // surface this app does not paint itself, the window buttons included —
    // and, through `prefers-color-scheme`, what the renderer paints too, which
    // is what keeps the first frame from flashing the wrong theme.
    applyTheme(readSettings().theme);
    // The one theme change that arrives through no settings write: the user
    // flips the OS appearance while `system` is selected. The renderer follows
    // on its own (its media query moves); the window's own ground does not.
    watchSystemAppearance(() => readSettings().theme);

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

    // Before the window, because the menu bar is drawn the moment the app
    // activates and replacing it afterwards shows the default one first.
    installApplicationMenu({ isDev });
    registerIpc(supervisor, updates);
    // Armed here, but the first check is deliberately delayed inside the
    // service — launch is busy enough, and an update banner is worth nothing
    // before the window has painted.
    updates.start(readSettings().checkForUpdates);
    // Debris from previous updates, cleared at the one moment nothing here is
    // running. Not gated on the auto-check setting: a user who switched checks
    // off still has whatever the last update left on their disk.
    void updates.sweepDebris();
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
    // Nothing should fire a check into a process that is on its way out —
    // including the relaunch an installed update triggers, which quits through
    // exactly this path.
    updates.stop();
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
