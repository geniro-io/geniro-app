import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { IPC } from '../shared/contracts';
import { detectClis } from './cli-detect';
import type { DaemonSupervisor } from './daemon-supervisor';
import { readGitInfo, switchBranch } from './git-info';
import {
  branchNameSchema,
  gitDirSchema,
  onboardingInputSchema,
  openTerminalSchema,
  revealPathSchema,
  settingsPatchSchema,
} from './ipc-schemas';
import { openInTerminal } from './open-terminal';
import { revealPath } from './reveal-path';
import { readSettings, updateSettings } from './settings';
import { checkForUpdates } from './updater';

/**
 * Register every privileged channel the renderer can invoke. The renderer has
 * no Node/Electron access; each handler here is one entry in the GeniroApi
 * contract exposed via the preload.
 */
export function registerIpc(supervisor: DaemonSupervisor): void {
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
    // Both of these are read when the daemon PROCESS is launched — CLI paths
    // ride its env, and the inspector is a launch flag — so neither can take
    // effect on the running one. Respawning here is what makes the toggle mean
    // what it says the moment it is flipped.
    if (parsed.cliPaths !== undefined || parsed.daemonInspect !== undefined) {
      await restartAndNotify(event);
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

  ipcMain.handle(IPC.checkForUpdates, () => checkForUpdates());

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
