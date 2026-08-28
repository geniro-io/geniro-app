import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
  webUtils,
} from 'electron';

import { type GeniroApi, IPC } from '../shared/contracts';

/**
 * The only bridge between the sandboxed renderer and the privileged main
 * process. Request methods forward to ipcMain.handle channels; daemon restart
 * notifications subscribe to a main-process event. The renderer never sees
 * Node or Electron directly.
 */
const api: GeniroApi = {
  getStatus: () =>
    ipcRenderer.invoke(IPC.getStatus) as ReturnType<GeniroApi['getStatus']>,
  getDaemonHandle: () =>
    ipcRenderer.invoke(IPC.getDaemonHandle) as ReturnType<
      GeniroApi['getDaemonHandle']
    >,
  onDaemonRestarted: (listener) => {
    const handler = (_event: IpcRendererEvent, handle: unknown): void => {
      listener(handle as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IPC.onDaemonRestarted, handler);
    return () => ipcRenderer.removeListener(IPC.onDaemonRestarted, handler);
  },
  onClearAgentCaches: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on(IPC.onClearAgentCaches, handler);
    return () => ipcRenderer.removeListener(IPC.onClearAgentCaches, handler);
  },
  pickProjectFolder: () =>
    ipcRenderer.invoke(IPC.pickProjectFolder) as ReturnType<
      GeniroApi['pickProjectFolder']
    >,
  pickAgentBinary: () =>
    ipcRenderer.invoke(IPC.pickAgentBinary) as ReturnType<
      GeniroApi['pickAgentBinary']
    >,
  getSettings: () =>
    ipcRenderer.invoke(IPC.getSettings) as ReturnType<GeniroApi['getSettings']>,
  updateSettings: (patch) =>
    ipcRenderer.invoke(IPC.updateSettings, patch) as ReturnType<
      GeniroApi['updateSettings']
    >,
  detectClis: () =>
    ipcRenderer.invoke(IPC.detectClis) as ReturnType<GeniroApi['detectClis']>,
  completeOnboarding: (input) =>
    ipcRenderer.invoke(IPC.completeOnboarding, input) as ReturnType<
      GeniroApi['completeOnboarding']
    >,
  pickWorkflowImport: () =>
    ipcRenderer.invoke(IPC.pickWorkflowImport) as ReturnType<
      GeniroApi['pickWorkflowImport']
    >,
  pickWorkflowExport: (defaultName) =>
    ipcRenderer.invoke(IPC.pickWorkflowExport, defaultName) as ReturnType<
      GeniroApi['pickWorkflowExport']
    >,
  getUpdateState: () =>
    ipcRenderer.invoke(IPC.getUpdateState) as ReturnType<
      GeniroApi['getUpdateState']
    >,
  checkForUpdates: () =>
    ipcRenderer.invoke(IPC.checkForUpdates) as ReturnType<
      GeniroApi['checkForUpdates']
    >,
  installUpdate: () =>
    ipcRenderer.invoke(IPC.installUpdate) as ReturnType<
      GeniroApi['installUpdate']
    >,
  relaunchForUpdate: () =>
    ipcRenderer.invoke(IPC.relaunchForUpdate) as ReturnType<
      GeniroApi['relaunchForUpdate']
    >,
  onUpdateState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      listener(state as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IPC.onUpdateState, handler);
    return () => ipcRenderer.removeListener(IPC.onUpdateState, handler);
  },
  getGitInfo: (dir) =>
    ipcRenderer.invoke(IPC.getGitInfo, dir) as ReturnType<
      GeniroApi['getGitInfo']
    >,
  openInTerminal: (input) =>
    ipcRenderer.invoke(IPC.openInTerminal, input) as ReturnType<
      GeniroApi['openInTerminal']
    >,
  openTerminalAt: (cwd) =>
    ipcRenderer.invoke(IPC.openTerminalAt, cwd) as ReturnType<
      GeniroApi['openTerminalAt']
    >,
  switchBranch: (dir, branch) =>
    ipcRenderer.invoke(IPC.switchBranch, dir, branch) as ReturnType<
      GeniroApi['switchBranch']
    >,
  pullBranch: (dir) =>
    ipcRenderer.invoke(IPC.pullBranch, dir) as ReturnType<
      GeniroApi['pullBranch']
    >,
  revealPath: (path) =>
    ipcRenderer.invoke(IPC.revealPath, path) as ReturnType<
      GeniroApi['revealPath']
    >,
  toggleDevTools: () =>
    ipcRenderer.invoke(IPC.toggleDevTools) as ReturnType<
      GeniroApi['toggleDevTools']
    >,
  notify: (notification) =>
    ipcRenderer.invoke(IPC.notify, notification) as ReturnType<
      GeniroApi['notify']
    >,
  testNotification: () =>
    ipcRenderer.invoke(IPC.testNotification) as ReturnType<
      GeniroApi['testNotification']
    >,
  openNotificationSettings: () =>
    ipcRenderer.invoke(IPC.openNotificationSettings) as ReturnType<
      GeniroApi['openNotificationSettings']
    >,
  onNotificationActivated: (listener) => {
    const handler = (_event: IpcRendererEvent, runId: unknown): void => {
      listener(runId as string);
    };
    ipcRenderer.on(IPC.onNotificationActivated, handler);
    return () =>
      ipcRenderer.removeListener(IPC.onNotificationActivated, handler);
  },
  // No `ipcRenderer.invoke` here: `webUtils` is a RENDERER-side module, and a
  // `File` could not cross to main anyway. Electron returns '' for a file with
  // no path on disk; the renderer wants that as an absence.
  filePath: (file) => webUtils.getPathForFile(file) || null,
};

contextBridge.exposeInMainWorld('geniro', api);
