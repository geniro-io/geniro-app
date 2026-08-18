import { join } from 'node:path';

import { app, BrowserWindow } from 'electron';

import {
  IPC,
  UPDATE_COMMAND,
  type UpdatePhase,
  type UpdateState,
} from '../shared/contracts';
import {
  canWriteBundle,
  type InstallInput,
  installUpdate,
  resolveBundlePath,
} from './update-installer';
import {
  fetchLatestRelease,
  isNewerVersion,
  type LatestRelease,
  type ReleaseLookup,
} from './updater';

/**
 * The one place that decides whether the app is out of date and what to do
 * about it.
 *
 * It owns a single {@link UpdateState} and pushes it at every window on every
 * change, so the banner over the views and the Settings section are two
 * renderings of one fact rather than two screens each polling and each free to
 * be showing something different. The renderer never checks or installs on its
 * own — it reports a press, exactly as it does for notifications.
 */

/**
 * Five minutes between automatic checks.
 *
 * It was six hours, on the reasoning that a machine left running for a week
 * should make only a handful of calls to an unauthenticated GitHub endpoint.
 * That is comfortably affordable at this cadence too: the limit on that
 * endpoint is 60 requests per hour per IP, and this spends 12 — a fifth of it,
 * leaving room for the other callers on the same machine.
 *
 * What the long interval actually cost was the point of the feature. A release
 * cut while the app is open could sit unnoticed for most of a working day, and
 * the app never quits on macOS, so the launch check does not cover it either.
 * The user's own ask was to be told promptly and be able to act on it from
 * where the version is already shown.
 */
const CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * Wait before the launch check.
 *
 * The first seconds after launch are spent spawning the daemon, loading the
 * renderer and probing the CLIs; a release-feed fetch competing with that buys
 * nothing — nobody is going to act on an update banner before the window has
 * even painted.
 */
const LAUNCH_CHECK_DELAY_MS = 8_000;

export interface UpdateServiceDeps {
  /** The running app's version. */
  currentVersion: () => string;
  /** False under `electron-vite dev`, where there is no bundle to replace. */
  isPackaged: () => boolean;
  /** The `.app` this process runs from, or null when it is not in one. */
  bundlePath: () => string | null;
  /** Scratch directory for downloads. */
  workDir: () => string;
  fetchLatest: () => Promise<ReleaseLookup>;
  install: (input: InstallInput) => Promise<void>;
  canWrite: (bundlePath: string) => Promise<boolean>;
  /** Quit and come back up on the freshly-swapped bundle. */
  relaunch: () => void;
  /** Push the new state at every renderer. */
  broadcast: (state: UpdateState) => void;
  intervalMs?: number;
  launchDelayMs?: number;
}

export class UpdateService {
  private state: UpdateState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private launchTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The release the current `available` state refers to.
   *
   * Held rather than re-fetched at install time so the version the user pressed
   * the button about is the version that gets installed — a re-fetch could
   * quietly hand them a different one published in between.
   */
  private release: LatestRelease | null = null;
  /** In flight, so a second press does not start a second download. */
  private busy = false;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.state = {
      phase: 'idle',
      version: null,
      progress: null,
      message: deps.isPackaged()
        ? null
        : 'Updates are handled by your dev checkout, not by the app.',
      currentVersion: deps.currentVersion(),
      canInstall: false,
    };
  }

  getState(): UpdateState {
    return this.state;
  }

  /**
   * Begin (or stop) automatic checking, per the user's settings toggle.
   *
   * Called at launch and again whenever the toggle is flipped, so switching it
   * on starts checking immediately rather than at the next launch. A MANUAL
   * check still works with it off: the switch governs what the app does by
   * itself, not what the user may ask for.
   */
  start(enabled: boolean): void {
    this.stop();
    if (!enabled || !this.deps.isPackaged()) {
      return;
    }
    const interval = this.deps.intervalMs ?? CHECK_INTERVAL_MS;
    this.launchTimer = setTimeout(() => {
      this.launchTimer = null;
      void this.check();
    }, this.deps.launchDelayMs ?? LAUNCH_CHECK_DELAY_MS);
    this.launchTimer.unref?.();
    this.timer = setInterval(() => void this.check(), interval);
    // Never the reason this process stays alive.
    this.timer.unref?.();
  }

  /** Stop automatic checking (settings flip, or app shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.launchTimer) {
      clearTimeout(this.launchTimer);
      this.launchTimer = null;
    }
  }

  /** Ask the release feed now. Resolves with the state the check produced. */
  async check(): Promise<UpdateState> {
    if (!this.deps.isPackaged()) {
      return this.state;
    }
    if (this.busy) {
      return this.state;
    }
    this.busy = true;
    try {
      this.emit({ phase: 'checking', message: null, progress: null });
      const lookup = await this.deps.fetchLatest();
      if (!lookup.ok) {
        return this.emit({ phase: 'error', message: lookup.error });
      }
      const { release } = lookup;
      if (!isNewerVersion(release.version, this.deps.currentVersion())) {
        this.release = null;
        return this.emit({
          phase: 'up-to-date',
          version: this.deps.currentVersion(),
          message: null,
        });
      }
      this.release = release;
      const canInstall = await this.resolveCanInstall();
      return this.emit({
        phase: 'available',
        version: release.version,
        // An install that cannot replace itself still gets told what CAN — a
        // banner announcing a version with no way to reach it is worse than
        // the sentence naming one command.
        message: canInstall ? null : `Update with: ${UPDATE_COMMAND}`,
        canInstall,
      });
    } finally {
      this.busy = false;
    }
  }

  /**
   * Apply the available update, then relaunch.
   *
   * Refuses rather than re-checking when nothing is pending: this is only ever
   * reached from a button the app itself only shows in the `available` state,
   * so arriving here without a release means the state changed under the user
   * and installing "whatever is latest" would not be what they pressed.
   */
  async install(): Promise<UpdateState> {
    // BEFORE the readiness guard, not after: a second call while the first is
    // downloading would otherwise fail that guard — the phase is `downloading`
    // by then, not `available` — and overwrite a running download with "there
    // is no update ready to install".
    if (this.busy) {
      return this.state;
    }
    const release = this.release;
    if (!release || this.state.phase !== 'available') {
      return this.emit({
        phase: 'error',
        message: 'there is no update ready to install',
      });
    }
    // Latched SYNCHRONOUSLY, before the first await. Set after it, two presses
    // a few milliseconds apart both pass the check and start their own
    // download of the same release into the same scratch directory.
    this.busy = true;
    try {
      const bundlePath = this.deps.bundlePath();
      if (!bundlePath || !(await this.resolveCanInstall())) {
        return this.emit({
          phase: 'error',
          message: `this copy of Geniro cannot replace itself — update with: ${UPDATE_COMMAND}`,
        });
      }
      this.emit({ phase: 'downloading', progress: 0, message: null });
      await this.deps.install({
        release,
        bundlePath,
        workDir: this.deps.workDir(),
        onStage: (stage) => {
          if (stage === 'installing') {
            this.emit({ phase: 'installing', progress: null });
          }
        },
        onProgress: ({ fraction }) => {
          // Whole percents only: a 150MB download fires thousands of chunk
          // events, and every one of them would be an IPC message and a React
          // render for a bar that cannot show the difference.
          const next =
            fraction === null ? null : Math.floor(fraction * 100) / 100;
          if (
            this.state.phase === 'downloading' &&
            next !== this.state.progress
          ) {
            this.emit({ progress: next });
          }
        },
      });
    } catch (err) {
      return this.emit({
        phase: 'error',
        progress: null,
        message: `${err instanceof Error ? err.message : String(err)} — you can still update with: ${UPDATE_COMMAND}`,
      });
    } finally {
      // Released on EVERY path out of the try, including the two early
      // returns: leaving it latched would refuse every further check and press
      // for the rest of the launch.
      this.busy = false;
    }
    // The new bundle is on disk. The app does NOT restart itself here, and that
    // is the user's own ask ("after update there should be a reload button to
    // relaunch app"): a relaunch quits this process, which takes the daemon and
    // every turn running under it with it — so choosing the moment belongs to
    // the person who might be mid-conversation. `ready` is the state that says
    // "installed, waiting on you"; {@link relaunch} is the button.
    return this.emit({
      phase: 'ready',
      progress: null,
      message: null,
      currentVersion: release.version,
    });
  }

  /**
   * Restart into the bundle {@link install} swapped in.
   *
   * Only from `ready`. Anywhere else there is nothing new on disk to come back
   * into, so a stray press would quit the app and change nothing — which is
   * indistinguishable from a crash.
   */
  relaunch(): UpdateState {
    if (this.state.phase !== 'ready') {
      return this.state;
    }
    this.deps.relaunch();
    return this.state;
  }

  /**
   * Whether this install can replace itself — asked of the filesystem, not
   * assumed.
   *
   * Deliberately re-asked at each use rather than cached at construction: an
   * app can be moved, or its permissions changed, while it is running, and the
   * answer decides between an Update button and a command the user must type.
   */
  private async resolveCanInstall(): Promise<boolean> {
    const bundlePath = this.deps.bundlePath();
    if (!this.deps.isPackaged() || !bundlePath) {
      return false;
    }
    return this.deps.canWrite(bundlePath);
  }

  /** Merge a patch into the state and push it at every window. */
  private emit(
    patch: Partial<UpdateState> & { phase?: UpdatePhase },
  ): UpdateState {
    this.state = { ...this.state, ...patch };
    this.deps.broadcast(this.state);
    return this.state;
  }
}

/** The production service, wired to electron and the real network/filesystem. */
export function createUpdateService(): UpdateService {
  return new UpdateService({
    currentVersion: () => app.getVersion(),
    isPackaged: () => app.isPackaged,
    bundlePath: () => resolveBundlePath(app.getPath('exe')),
    workDir: () => join(app.getPath('userData'), 'updates'),
    fetchLatest: fetchLatestRelease,
    install: installUpdate,
    canWrite: canWriteBundle,
    relaunch: () => {
      // Electron spawns the replacement only after this instance has exited,
      // which is what makes relaunching into a bundle we just swapped safe:
      // the single-instance lock is released and `process.execPath` resolves
      // to the new binary at the same path.
      app.relaunch();
      app.quit();
    },
    broadcast: (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.onUpdateState, state);
        }
      }
    },
  });
}
