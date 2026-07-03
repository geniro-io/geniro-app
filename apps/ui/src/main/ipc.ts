import { dialog, ipcMain } from 'electron';

import { IPC } from '../shared/contracts';
import { detectClis } from './cli-detect';
import type { DaemonSupervisor } from './daemon-supervisor';
import {
  onboardingInputSchema,
  secretNameSchema,
  secretValueSchema,
  settingsPatchSchema,
} from './ipc-schemas';
import { deleteSecret, hasSecret, saveSecret } from './keychain';
import { readSettings, updateSettings } from './settings';
import { checkForUpdates } from './updater';

/**
 * Register every privileged channel the renderer can invoke. The renderer has
 * no Node/Electron access; each handler here is one entry in the GeniroApi
 * contract exposed via the preload.
 */
export function registerIpc(supervisor: DaemonSupervisor): void {
  ipcMain.handle(IPC.getStatus, () => {
    const settings = readSettings();
    return {
      onboardingComplete: settings.onboardingComplete,
      daemon: {
        connected: supervisor.isConnected(),
        handle: supervisor.getHandle(),
      },
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

  ipcMain.handle(IPC.updateSettings, (_event, patch: unknown) =>
    updateSettings(settingsPatchSchema.parse(patch)),
  );

  ipcMain.handle(IPC.detectClis, () => detectClis(readSettings()));

  ipcMain.handle(IPC.saveSecret, (_event, name: unknown, value: unknown) => {
    saveSecret(secretNameSchema.parse(name), secretValueSchema.parse(value));
  });

  ipcMain.handle(IPC.hasSecret, (_event, name: unknown) =>
    hasSecret(secretNameSchema.parse(name)),
  );

  ipcMain.handle(IPC.deleteSecret, (_event, name: unknown) => {
    deleteSecret(secretNameSchema.parse(name));
  });

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

  ipcMain.handle(IPC.completeOnboarding, (_event, input: unknown) => {
    const { cliPaths, cursorApiKey } = onboardingInputSchema.parse(input);
    if (cursorApiKey) {
      saveSecret('cursor.apiKey', cursorApiKey);
    }
    // Merge over existing overrides so a re-run of onboarding never clears a
    // previously-set agent path the user didn't touch this time.
    const current = readSettings();
    return updateSettings({
      onboardingComplete: true,
      cliPaths: { ...current.cliPaths, ...(cliPaths ?? {}) },
    });
  });
}
