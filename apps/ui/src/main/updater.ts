import { app } from 'electron';

import type { UpdateCheckResult } from '../shared/contracts';

/** Registered once so a background download rejection never goes unhandled. */
let errorListenerAttached = false;

/**
 * electron-updater wiring. The feed is GitHub Releases (electron-builder's
 * `publish` config, baked into the packaged app-update.yml). The whole app —
 * shell + bundled daemon — ships as ONE artifact, so every update is
 * inherently version-locked: shell and daemon can never skew. A check
 * downloads in the background and installs on the next quit
 * (autoInstallOnAppQuit).
 *
 * `allowDowngrade` is on so a rollback works as documented: publishing an
 * OLDER version to the feed makes the updater follow it. Availability is read
 * from electron-updater's own `isUpdateAvailable` (semver-aware, downgrade-aware)
 * — NOT a raw version-string compare, which would mislabel a refused downgrade
 * as "available" and promise an install that never happens.
 *
 * Dev launches short-circuit before the module loads: an unpackaged app has
 * no app-update.yml to read, and electron-updater throws on it.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) {
    return {
      status: 'dev',
      version: app.getVersion(),
      message: 'update checks are disabled in dev',
    };
  }
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // The v1 rollback story (spec §10): publishing an OLDER release makes
    // every client follow the feed down. Accepted trade-off: whoever can write
    // releases can also downgrade a signed fleet to a validly-signed old
    // version — tighten (explicit rollback affordance / version floor) when
    // distribution signing lands.
    autoUpdater.allowDowngrade = true;
    if (!errorListenerAttached) {
      // With autoDownload the download continues past checkForUpdates() and
      // rejects on the returned downloadPromise AND emits 'error'; without a
      // listener that becomes an unhandled main-process rejection.
      autoUpdater.on('error', (err) =>
        console.error(
          '[ui] updater error:',
          err instanceof Error ? err.message : err,
        ),
      );
      errorListenerAttached = true;
    }
    const result = await autoUpdater.checkForUpdates();
    if (!result?.isUpdateAvailable) {
      return { status: 'up-to-date', version: app.getVersion(), message: null };
    }
    const version = result.updateInfo.version;
    // Surface a failed background download instead of leaving the user with a
    // "downloading…" message that silently never installs.
    result.downloadPromise?.catch((err) =>
      console.error(
        '[ui] update download failed:',
        err instanceof Error ? err.message : err,
      ),
    );
    return {
      status: 'available',
      version,
      message: `downloading v${version} — it installs on the next launch`,
    };
  } catch (err) {
    return {
      status: 'error',
      version: null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Launch-time check, gated by the user's settings toggle. Fire-and-forget. */
export function checkOnLaunch(enabled: boolean): void {
  if (!enabled || !app.isPackaged) {
    return;
  }
  void checkForUpdates().then((result) => {
    if (result.status === 'error') {
      console.error('[ui] launch update check failed:', result.message);
    }
  });
}
