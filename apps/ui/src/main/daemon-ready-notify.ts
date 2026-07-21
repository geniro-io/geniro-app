import type { BrowserWindow } from 'electron';

import { type DaemonHandle, IPC } from '../shared/contracts';

/** The slice of BrowserWindow the notify needs — the spec's seam. */
export type NotifyTarget = Pick<BrowserWindow, 'isDestroyed' | 'webContents'>;

/**
 * Push the freshly started daemon's handle to the renderer. The window can be
 * destroyed (or already gone) between the daemon becoming healthy and this
 * send — quitting during boot — and a send() into that gap throws; neither
 * case is a daemon-start failure, so it must not surface as one.
 */
export function notifyDaemonReady(
  window: NotifyTarget | null,
  handle: DaemonHandle,
): void {
  try {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.onDaemonRestarted, handle);
    }
  } catch (err) {
    console.error('[ui] daemon-ready notify failed:', err);
  }
}
