import { contextBridge, ipcRenderer } from 'electron';

import { type GeniroApi, IPC } from '../shared/contracts';

/**
 * The only bridge between the sandboxed renderer and the privileged main
 * process. Every method forwards to an ipcMain.handle channel; the renderer
 * never sees Node or Electron directly. Casts pin `invoke`'s `Promise<any>`
 * back to the typed GeniroApi contract.
 */
const api: GeniroApi = {
  getStatus: () =>
    ipcRenderer.invoke(IPC.getStatus) as ReturnType<GeniroApi['getStatus']>,
  getDaemonHandle: () =>
    ipcRenderer.invoke(IPC.getDaemonHandle) as ReturnType<
      GeniroApi['getDaemonHandle']
    >,
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
};

contextBridge.exposeInMainWorld('geniro', api);
