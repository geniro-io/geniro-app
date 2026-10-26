import type { BrowserWindow } from 'electron';

import { IPC } from '../shared/contracts';

/** The slice of BrowserWindow the notify needs — the spec's seam. */
export type SettingsNotifyTarget = Pick<
  BrowserWindow,
  'isDestroyed' | 'webContents'
>;

/**
 * Tell every window the settings file was just written — by the Settings
 * screen, another window or a paired phone — so a view showing figures
 * derived from settings (the workflow inspector's instruction sizes) can read
 * them again. Carries no settings: a window that cares re-reads them.
 *
 * A window can be destroyed between the write and this send, and a send into
 * that gap throws; that is never the writer's failure.
 */
export function notifySettingsChanged(
  windows: readonly SettingsNotifyTarget[],
): void {
  for (const window of windows) {
    try {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.onSettingsChanged);
      }
    } catch (err) {
      console.error('[ui] settings-changed notify failed:', err);
    }
  }
}
