import { join } from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

import { DaemonSupervisor } from './daemon-supervisor';
import { registerIpc } from './ipc';

const supervisor = new DaemonSupervisor();
let teardownDone = false;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    title: 'geniro',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  // Open external links in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // electron-vite sets ELECTRON_RENDERER_URL in dev; otherwise load the build.
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(async () => {
  registerIpc(supervisor);

  try {
    await supervisor.start();
  } catch (err) {
    // Surface the failure but still open the window — the renderer renders a
    // disconnected state rather than the app failing to launch.
    console.error('[ui] daemon failed to start:', err);
  }

  createWindow();

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
