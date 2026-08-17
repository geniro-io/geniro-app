/**
 * Open the OS pane where a silenced app is un-silenced.
 *
 * The Settings screen could already TELL a user where to go — "System Settings
 * › Notifications › Geniro" — and that is exactly what the report was about: a
 * user who had run the test, seen no banner, read the sentence, and still had
 * to go and find the pane themselves. A sentence naming a destination is a
 * worse version of a button that goes there.
 *
 * This is why it does NOT live in `notifier.ts`, the one file that may touch a
 * notification API: nothing here posts anything. It is a URL and the reasoning
 * behind it, kept out of `ipc.ts` so the reasoning has somewhere to live and
 * the opener can be swapped for a spy in a spec.
 */

/**
 * macOS's Notifications pane, as a URL.
 *
 * Verified on macOS 26.6.1 (build 25G76) by reading the pane's own manifest,
 * `/System/Library/ExtensionKit/Extensions/NotificationsSettings.appex`:
 *
 * - `CFBundleIdentifier` is `com.apple.Notifications-Settings.extension` — the
 *   id used here.
 * - `allowsXAppleSystemPreferencesURLScheme` is `true`, which is what makes the
 *   `x-apple.systempreferences:` scheme resolve to it at all.
 * - `legacyBundleIdentifier` is `com.apple.preference.notifications`, the
 *   pre-Ventura pane id — still aliased, so the older URL found in most
 *   snippets works too. The current id is used rather than the alias because
 *   an alias is a compatibility shim and is the half Apple eventually drops.
 *
 * There is deliberately no attempt to deep-link to Geniro's own ROW. No such
 * anchor is documented, and a URL that silently lands on the pane's top when it
 * stops working is indistinguishable from one that never worked — the copy
 * beside the button names the row instead.
 */
export const NOTIFICATION_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.Notifications-Settings.extension';

/**
 * Hand the OS its own pane URL.
 *
 * The URL is a CONSTANT here rather than a parameter from the renderer, and
 * that is the security half: `shell.openExternal` on caller-supplied input is
 * the Electron checklist's #14, and `main/index.ts` already refuses every
 * scheme outside http/https/mailto for exactly that reason. This scheme is not
 * on that list and must not be added to it — a renderer that could name an
 * `x-apple.systempreferences:` target could aim the user at any pane on the
 * machine. It can only ask for THIS one.
 */
export async function openNotificationSettings(
  open: (url: string) => Promise<void>,
): Promise<void> {
  await open(NOTIFICATION_SETTINGS_URL);
}
