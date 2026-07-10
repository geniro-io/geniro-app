import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

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
  saveSecret: (name, value) =>
    ipcRenderer.invoke(IPC.saveSecret, name, value) as ReturnType<
      GeniroApi['saveSecret']
    >,
  hasSecret: (name) =>
    ipcRenderer.invoke(IPC.hasSecret, name) as ReturnType<
      GeniroApi['hasSecret']
    >,
  deleteSecret: (name) =>
    ipcRenderer.invoke(IPC.deleteSecret, name) as ReturnType<
      GeniroApi['deleteSecret']
    >,
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
  checkForUpdates: () =>
    ipcRenderer.invoke(IPC.checkForUpdates) as ReturnType<
      GeniroApi['checkForUpdates']
    >,
};

contextBridge.exposeInMainWorld('geniro', api);
