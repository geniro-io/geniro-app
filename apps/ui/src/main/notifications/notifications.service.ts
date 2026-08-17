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

/**
 * How long a test banner waits for the platform to say what became of it, and
 * how often it checks.
 *
 * Bounded because a silent platform is a real outcome and not an error to hang
 * on: macOS answers within a frame or two when it answers at all.
 */
const OUTCOME_WAIT_MS = 2_000;
const OUTCOME_POLL_MS = 50;

/** Where a clicked banner leads: a window to raise and a renderer to tell. */
export interface NotificationTarget {
  /** Null when the sender has no window — the banner still reports. */
  window: NotificationWindow | null;
  /** Tell the renderer which run the user clicked through to. */
  onActivate(runId: string): void;
}

export class NotificationService {
  /**
   * What the platform said about the last banner this app posted, or null
   * before it has posted one.
   *
   * Kept because the answer arrives too late to return: `show()` is fire and
   * forget, and macOS reports `show`/`failed` afterwards. It is what lets a
   * user asking "why do I get no notifications?" be told something specific —
   * see {@link testPost}.
   */
  private lastOutcome: { shown: boolean; error: string | null } | null = null;

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
        (outcome) => {
          this.lastOutcome = outcome;
          if (!outcome.shown) {
            // The one failure mode this app could not previously see. Logged
            // AND kept: the log is gone in a packaged Finder launch, and the
            // kept value is what a "send a test notification" control reports
            // back to the user.
            console.error(
              `[ui] the system refused a notification: ${outcome.error ?? 'no reason given'}`,
            );
          }
        },
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
   * Post a banner the USER asked for, and answer what became of it.
   *
   * It exists because every other path here is fire-and-forget by design, which
   * leaves "I get no notifications" undiagnosable from inside the app: the
   * setting can be on, the code can run, and macOS can still present nothing —
   * an app it has never been authorised for, or one silenced in System
   * Settings, fails exactly as quietly as one that worked.
   *
   * It is also the honest way to REQUEST that authorisation. macOS asks the
   * first time an app posts, and consumes that notification to do it, so the
   * first real banner a user should have seen is always spent on the prompt.
   * Spending a deliberate test on it instead means the prompt arrives while
   * they are looking at the switch they just turned on.
   *
   * Waits for the platform's verdict rather than returning at once — with a cap,
   * because a platform that reports neither outcome must not hang the caller.
   */
  async testPost(target: NotificationTarget): Promise<{
    posted: boolean;
    shown: boolean | null;
    reason: string | null;
  }> {
    if (!this.readSettings().notificationsEnabled) {
      return {
        posted: false,
        shown: null,
        reason: 'notifications are switched off in these settings',
      };
    }
    if (!this.notifier.isSupported()) {
      return {
        posted: false,
        shown: null,
        reason: 'this machine reports no notification service',
      };
    }
    this.lastOutcome = null;
    const posted = this.post(
      {
        kind: 'turn-end',
        // A real run id would send a click into a thread that does not exist;
        // the empty one is refused by the activation path's own lookup.
        runId: '',
        title: 'Geniro',
        body: 'Notifications are working — this is what a finished turn looks like.',
      },
      target,
    );
    if (!posted) {
      return { posted: false, shown: null, reason: 'the banner was refused' };
    }
    const verdict = await this.awaitOutcome();
    return {
      posted: true,
      shown: verdict?.shown ?? null,
      reason:
        verdict === null
          ? // Neither event fired. Not called a failure: the banner may well be
            // sitting in Notification Centre, and the one thing that would be
            // wrong here is telling the user it failed when it did not.
            'the system did not report back — check Notification Centre, and System Settings › Notifications › Geniro'
          : verdict.shown
            ? null
            : (verdict.error ??
              'the system refused it — check System Settings › Notifications › Geniro'),
    };
  }

  /** The platform's verdict on the banner just posted, or null if it is mute. */
  private awaitOutcome(): Promise<{
    shown: boolean;
    error: string | null;
  } | null> {
    return new Promise((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (this.lastOutcome !== null) {
          clearInterval(poll);
          resolve(this.lastOutcome);
        } else if (Date.now() - started > OUTCOME_WAIT_MS) {
          clearInterval(poll);
          resolve(null);
        }
      }, OUTCOME_POLL_MS);
    });
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
