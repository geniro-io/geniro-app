import { dialog, ipcMain } from 'electron';

import {
  IPC,
  type OnboardingInput,
  type SecretName,
  type Settings,
} from '../shared/contracts';
import { detectClis } from './cli-detect';
import type { DaemonSupervisor } from './daemon-supervisor';
import { deleteSecret, hasSecret, saveSecret } from './keychain';
import { readSettings, updateSettings } from './settings';

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

  ipcMain.handle(IPC.getSettings, () => readSettings());

  ipcMain.handle(IPC.updateSettings, (_event, patch: Partial<Settings>) =>
    updateSettings(patch),
  );

  ipcMain.handle(IPC.detectClis, () => detectClis(readSettings()));

  ipcMain.handle(IPC.saveSecret, (_event, name: SecretName, value: string) => {
    saveSecret(name, value);
  });

  ipcMain.handle(IPC.hasSecret, (_event, name: SecretName) => hasSecret(name));

  ipcMain.handle(IPC.deleteSecret, (_event, name: SecretName) => {
    deleteSecret(name);
  });

  ipcMain.handle(IPC.completeOnboarding, (_event, input: OnboardingInput) => {
    if (input.cursorApiKey) {
      saveSecret('cursor.apiKey', input.cursorApiKey);
    }
    return updateSettings({
      projectFolder: input.projectFolder,
      onboardingComplete: true,
    });
  });
}
