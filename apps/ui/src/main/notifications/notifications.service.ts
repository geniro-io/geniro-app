import type { BrowserWindow } from 'electron';

import type { RunNotification, Settings } from '../../shared/contracts';
import { electronNotifier, type Notifier } from './notifier';

/**
 * The app's system notifications — one module owning the whole concern in this
 * process: whether a banner is posted at all, what it says, and what happens
 * when the user clicks it.
 *
 * The split across the two processes is deliberate and is the contract:
 *
 * - The **renderer** decides WHEN (`renderer/notifications/`) — it is the only
 *   side that holds the run statuses and knows which chat is on screen.
 * - This decides WHETHER, and does the posting. The setting is read at the
 *   moment of the post, so a flipped switch takes effect on the very next
 *   question instead of whenever a screen last cached its settings. Keeping the
 *   gate in the one place that can post a banner is what makes that true by
 *   construction rather than by every caller remembering.
 *
 * Nothing outside this directory imports a notification API; `ipc.ts` owns one
 * instance and hands it the sender's window.
 */

/** The slice of BrowserWindow a click acts on — the spec's seam. */
export type NotificationWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isMinimized' | 'restore' | 'show' | 'focus'
>;

/** Where a clicked banner leads: a window to raise and a renderer to tell. */
export interface NotificationTarget {
  /** Null when the sender has no window — the banner still reports. */
  window: NotificationWindow | null;
  /** Tell the renderer which run the user clicked through to. */
  onActivate(runId: string): void;
}

export class NotificationService {
  constructor(
    private readonly readSettings: () => Pick<Settings, 'notificationsEnabled'>,
    private readonly notifier: Notifier = electronNotifier,
  ) {}

  /**
   * Post one notification, unless the user has them switched off.
   *
   * Returns whether a banner was actually posted — which is what the specs pin
   * and what nobody else needs: a suppressed notification is a setting being
   * honoured, not a failure, and there is nothing a caller could do about one
   * the platform refused.
   */
  post(notification: RunNotification, target: NotificationTarget): boolean {
    if (!this.readSettings().notificationsEnabled) {
      return false;
    }
    if (!this.notifier.isSupported()) {
      return false;
    }
    try {
      this.notifier.post(
        { title: notification.title, body: notification.body },
        () => this.activate(notification.runId, target),
      );
      return true;
    } catch (err) {
      // The renderer awaits the IPC call behind this; a throw would surface as
      // a failed request in the middle of a chat, over a banner.
      console.error('[ui] notification failed:', err);
      return false;
    }
  }

  /**
   * Bring the app forward and hand the renderer the run to open.
   *
   * Raising the window is done HERE rather than left to the renderer for the
   * obvious reason: a renderer in a hidden window cannot show itself, and a
   * click is most likely to arrive precisely when the window is behind
   * something else or minimized.
   */
  private activate(runId: string, target: NotificationTarget): void {
    const { window } = target;
    if (window && !window.isDestroyed()) {
      // `restore` first: on macOS `show`/`focus` on a minimized window raise it
      // without un-minimizing, so the user gets a Dock bounce and no window.
      if (window.isMinimized()) {
        window.restore();
      }
      window.show();
      window.focus();
    }
    // Outside the window guard on purpose: whether the run can still be
    // delivered is the callback's own question, and it is the only side that
    // can answer it. Folding it in here would make a raise-the-window failure
    // silently swallow the run as well.
    target.onActivate(runId);
  }
}
