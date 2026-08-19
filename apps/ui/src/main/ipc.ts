import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  shell,
} from 'electron';

import { IPC } from '../shared/contracts';
import { detectClis } from './cli-detect';
import type { DaemonSupervisor } from './daemon-supervisor';
import { pullBranch, readGitInfo, switchBranch } from './git-info';
import {
  branchNameSchema,
  gitDirSchema,
  notificationSchema,
  onboardingInputSchema,
  openTerminalSchema,
  revealPathSchema,
  settingsPatchSchema,
} from './ipc-schemas';
import { openNotificationSettings } from './notifications/notification-settings';
import { NotificationService } from './notifications/notifications.service';
import { openInTerminal } from './open-terminal';
import { revealPath } from './reveal-path';
import { readSettings, updateSettings } from './settings';
import type { UpdateService } from './update-service';

/**
 * Register every privileged channel the renderer can invoke. The renderer has
 * no Node/Electron access; each handler here is one entry in the GeniroApi
 * contract exposed via the preload.
 */
export function registerIpc(
  supervisor: DaemonSupervisor,
  updates: UpdateService,
): void {
  // One instance for the app's lifetime, reading settings through the same
  // function every other handler here does — so the toggle it consults is
  // always the file's current state, never a value captured at registration.
  const notifications = new NotificationService(readSettings);

  const restartAndNotify = async (event: IpcMainInvokeEvent): Promise<void> => {
    const handle = await supervisor.restart();
    event.sender.send(IPC.onDaemonRestarted, handle);
  };

  ipcMain.handle(IPC.getStatus, () => {
    const settings = readSettings();
    return {
      onboardingComplete: settings.onboardingComplete,
      daemon: {
        connected: supervisor.isConnected(),
        handle: supervisor.getHandle(),
      },
      isPackaged: app.isPackaged,
    };
  });

  ipcMain.handle(IPC.getDaemonHandle, () => supervisor.getHandle());

  ipcMain.handle(IPC.pickProjectFolder, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.pickAgentBinary, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.getSettings, () => readSettings());

  ipcMain.handle(IPC.updateSettings, async (event, patch: unknown) => {
    const parsed = settingsPatchSchema.parse(patch);
    const settings = updateSettings(parsed);
    // All three are read when the daemon PROCESS is launched — CLI paths and
    // the browser-tools switch ride its env, the inspector is a launch flag —
    // so none of them can take effect on the running one. Respawning here is what makes the toggle mean
    // what it says the moment it is flipped.
    if (
      parsed.cliPaths !== undefined ||
      parsed.daemonInspect !== undefined ||
      parsed.claudeBrowserTools !== undefined
    ) {
      await restartAndNotify(event);
    }
    // Re-armed on the spot rather than at the next launch: switching automatic
    // checks ON and being told nothing until tomorrow is a switch that appears
    // not to work.
    if (parsed.checkForUpdates !== undefined) {
      updates.start(parsed.checkForUpdates);
    }
    return settings;
  });

  ipcMain.handle(IPC.detectClis, () => detectClis(readSettings()));

  ipcMain.handle(IPC.pickWorkflowImport, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Geniro workflow', extensions: ['yaml', 'yml'] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(
    IPC.pickWorkflowExport,
    async (_event, defaultName: unknown) => {
      const result = await dialog.showSaveDialog({
        defaultPath:
          typeof defaultName === 'string' && defaultName.length > 0
            ? defaultName
            : 'workflow.geniro.yaml',
        filters: [{ name: 'Geniro workflow', extensions: ['yaml', 'yml'] }],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
  );

  // No input on any of the three: what to check and what to install are main's
  // own facts (the release feed, this bundle's path), and a renderer that could
  // name either would be a renderer that could point the installer somewhere.
  ipcMain.handle(IPC.getUpdateState, () => updates.getState());
  ipcMain.handle(IPC.checkForUpdates, () => updates.check());
  ipcMain.handle(IPC.installUpdate, () => updates.install());
  ipcMain.handle(IPC.relaunchForUpdate, () => updates.relaunch());

  ipcMain.handle(IPC.getGitInfo, (_event, dir: unknown) =>
    readGitInfo(gitDirSchema.parse(dir)),
  );

  // Shape-validated here rather than trusted: this ends in an executable
  // script the main process writes and hands to LaunchServices.
  ipcMain.handle(IPC.openInTerminal, (_event, input: unknown) =>
    openInTerminal(openTerminalSchema.parse(input)),
  );

  ipcMain.handle(IPC.switchBranch, (_event, dir: unknown, branch: unknown) =>
    switchBranch(gitDirSchema.parse(dir), branchNameSchema.parse(branch)),
  );
  ipcMain.handle(IPC.pullBranch, (_event, dir: unknown) =>
    pullBranch(gitDirSchema.parse(dir)),
  );

  // Reveals, never opens, and only inside the daemon's log directory — the
  // confinement lives in `revealPath` beside the reason for it.
  ipcMain.handle(IPC.revealPath, (_event, path: unknown) =>
    revealPath(revealPathSchema.parse(path)),
  );

  // No schema: there is no input. Acts on the SENDER's own WebContents rather
  // than on a looked-up window, so this cannot be aimed at another window.
  ipcMain.handle(IPC.toggleDevTools, (event) => {
    event.sender.toggleDevTools();
  });

  // Whether this becomes a banner is the notifications module's call, reading
  // the setting at the moment of the post — the renderer reports the event and
  // never the verdict. Acts on the SENDER's own window, like toggleDevTools: a
  // notification cannot be aimed at another window, and the click has to raise
  // the window whose renderer asked for it.
  ipcMain.handle(IPC.notify, (event, input: unknown) => {
    notifications.post(notificationSchema.parse(input), {
      window: BrowserWindow.fromWebContents(event.sender),
      onActivate: (runId) => {
        // Back into the same renderer, so it can open the thread the banner
        // named. Guarded: the window can be gone by the time a banner posted
        // minutes ago is clicked, and a send into that gap throws.
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.onNotificationActivated, runId);
        }
      },
    });
  });

  // No input, and the SENDER's own window for the same reason `notify` uses it:
  // a test banner's click must raise the window that asked for it.
  ipcMain.handle(IPC.testNotification, (event) =>
    notifications.testPost({
      window: BrowserWindow.fromWebContents(event.sender),
      onActivate: (runId) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.onNotificationActivated, runId);
        }
      },
    }),
  );

  // No input at all, and that is the point — see the module's own doc block.
  // The renderer asks for THE notifications pane, not for a URL of its choosing.
  ipcMain.handle(IPC.openNotificationSettings, () =>
    openNotificationSettings((url) => shell.openExternal(url)),
  );

  ipcMain.handle(IPC.completeOnboarding, async (event, input: unknown) => {
    const { cliPaths } = onboardingInputSchema.parse(input);
    // Merge over existing overrides so a re-run of onboarding never clears a
    // previously-set agent path the user didn't touch this time.
    const current = readSettings();
    const settings = updateSettings({
      onboardingComplete: true,
      cliPaths: { ...current.cliPaths, ...(cliPaths ?? {}) },
    });
    await restartAndNotify(event);
    return settings;
  });
}
