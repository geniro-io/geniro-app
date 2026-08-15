import { Notification } from 'electron';

/**
 * The transport a notification is posted over — the ONE file in this app that
 * touches a notification API.
 *
 * ## Why Electron's own `Notification` and not an npm package
 *
 * This IS the ready-made library: `Notification` is Electron's first-party
 * binding to `UNUserNotificationCenter`, already in the dependency tree, and it
 * is the only option that satisfies the three things this feature needs.
 *
 * - **Identity.** A banner posted through Electron is attributed to *Geniro*,
 *   with the app's icon, and lands in the user's Notification Centre under the
 *   app's own entry — which is where they go to silence it in System Settings.
 *   `node-notifier`, the usual suggestion, shells out to a bundled
 *   `terminal-notifier.app`, so the banner is attributed to THAT helper. The
 *   per-app switch in System Settings then does not name Geniro at all.
 * - **Signing.** `node-notifier` ships a Mach-O helper binary inside
 *   `node_modules`. This app is ad-hoc signed with no Developer ID and no
 *   notarization (see `scripts/build-mac.mjs`), and a nested unsigned executable
 *   is exactly what Gatekeeper stops. The built-in has no extra binary to sign.
 * - **The click.** A banner you cannot act on only tells you to go looking. The
 *   `click` event here is in-process, so it can raise the actual
 *   `BrowserWindow`; a helper binary's click cannot reach into this process at
 *   all.
 *
 * So the interface below exists for TESTABILITY, not to keep a second
 * implementation in reserve — {@link electronNotifier} is the only one, and a
 * spec swaps it for a double rather than for another vendor.
 */

/** One posted banner, from the caller's point of view. */
export interface Notifier {
  /**
   * Whether this machine can show a notification at all. False on a system
   * with no notification service, where posting throws rather than no-ops.
   */
  isSupported(): boolean;
  /**
   * Show a banner. `onClick` fires if the user activates it — which may be long
   * after this returns, or never.
   */
  post(options: { title: string; body: string }, onClick: () => void): void;
}

export const electronNotifier: Notifier = {
  isSupported: () => Notification.isSupported(),
  post: (options, onClick) => {
    const banner = new Notification(options);
    banner.on('click', onClick);
    banner.show();
  },
};
