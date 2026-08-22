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
  sweepUpdateDebris,
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

/**
 * Deadlines over the phases that are not an ending.
 *
 * REPORTED: an install sat on one non-terminal phase and never left it. Nothing
 * here timed a phase out and nothing reset one, and since main owns the state
 * and pushes it at every window, reloading the renderer only re-read the same
 * wedged value — the ONLY recourse was quitting the app, which nothing tells
 * the user. Every recognised failure already lands in `error`; what was missing
 * is a bound on the failures nobody recognised, so that a phase which stops
 * moving becomes one of them.
 *
 * The download's is a STALL budget rather than a total: it is re-armed by every
 * progress callback, so a 150MB transfer over a bad connection can take as long
 * as it takes while one that never starts still gives up. Three minutes because
 * the checksum fetch ahead of the first byte carries a 60s budget of its own.
 *
 * The other two are flat totals — neither reports progress. `checking` is a
 * metadata call the feed already bounds at 10s, so 60s here is a backstop for a
 * promise that never settles AT ALL rather than a slow answer; `installing` is
 * two `ditto` passes over ~150MB, normally well under a minute.
 */
const CHECK_DEADLINE_MS = 60_000;
const DOWNLOAD_STALL_MS = 3 * 60_000;
const INSTALL_DEADLINE_MS = 10 * 60_000;

/** `45s` / `3 minutes` — a duration in the words an error line wants. */
function humanize(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)} minutes`;
}

function checkTimedOut(ms: number): string {
  return `the update check did not finish within ${humanize(ms)}`;
}

function downloadStalled(ms: number): string {
  return `the update made no progress for ${humanize(ms)} — you can still update with: ${UPDATE_COMMAND}`;
}

function installTimedOut(ms: number): string {
  return `installing did not finish within ${humanize(ms)} — you can still update with: ${UPDATE_COMMAND}`;
}

/**
 * One line into the daemon's debug log, as the `ui` channel.
 *
 * REPORTED alongside the wedge, and the reason it could not be diagnosed at
 * all: everything this file knows went to `console`, and a packaged Finder
 * launch discards main's stdout. So the one process that could see the update
 * fail had no path into the log the user can actually open and paste — across
 * every log file on the machine, the day of the failure held nothing about it.
 *
 * Injected rather than imported, on the same rule as every other dependency
 * here: the class is driven in specs with no daemon and no network. The levels
 * are the daemon's own vocabulary, spelled out for the reason
 * `window-diagnostics.ts` spells them — the Electron side holds no daemon types.
 */
export type UpdateLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  context: Record<string, string>,
) => void;

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
  /** Remove what previous updates left on disk; resolves with what it removed. */
  sweep: (input: { workDir: string; bundlePath: string }) => Promise<string[]>;
  /** Push the new state at every renderer. */
  broadcast: (state: UpdateState) => void;
  /** Write one line where a user can read it back — see {@link UpdateLog}. */
  log: UpdateLog;
  intervalMs?: number;
  launchDelayMs?: number;
  checkDeadlineMs?: number;
  downloadStallMs?: number;
  installDeadlineMs?: number;
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
  /** The deadline over the phase in flight, if that phase is not an ending. */
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /**
   * Which attempt the in-flight work belongs to.
   *
   * Bumped when an attempt STARTS and again when the watchdog abandons one, so
   * every guard below fails for work that has been given up on. That is the
   * whole point: a hung call is still pending after the watchdog has moved the
   * app to `error`, and if it ever settles it must not write `ready` over the
   * failure the user has already been shown and may already have retried past.
   */
  private attempt = 0;
  /**
   * Cancels the abandoned attempt for real.
   *
   * Ignoring a hung install is not enough on its own. The user can retry the
   * moment the watchdog frees the app, and an abandoned attempt still inside
   * the bundle swap would then be a second `ditto` writing the same bundle.
   */
  private aborter: AbortController | null = null;

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
    // Both SILENT: nobody pressed anything, so a check that changes nothing must
    // leave the renderer alone entirely — see {@link check}'s `announce`.
    this.launchTimer = setTimeout(() => {
      this.launchTimer = null;
      void this.check({ announce: false });
    }, this.deps.launchDelayMs ?? LAUNCH_CHECK_DELAY_MS);
    this.launchTimer.unref?.();
    this.timer = setInterval(
      () => void this.check({ announce: false }),
      interval,
    );
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

  /**
   * Ask the release feed now. Resolves with the state the check produced.
   *
   * `announce` is what separates the two callers. A check the USER pressed has
   * to say it started — the Settings button reads "Checking…" and disables
   * itself, and a button that answers a press with nothing visible reads as
   * broken. The SCHEDULED check has no press to acknowledge and nothing to
   * show: `footerUpdate` maps `checking` to `{kind:'none'}`, so the phase was
   * pushed at every window, re-rendered the whole renderer from `App` down —
   * the transcript with it — and drew exactly nothing. REPORTED as the app
   * seeming to re-render itself every so often, which was the one event on
   * that cadence.
   */
  async check({
    announce = true,
  }: { announce?: boolean } = {}): Promise<UpdateState> {
    if (!this.deps.isPackaged()) {
      return this.state;
    }
    if (this.busy) {
      return this.state;
    }
    // `ready` is an ENDING, and the only one a check can undo. The version this
    // service compares against is the RUNNING app's, which does not change when
    // a bundle is swapped — it changes at the relaunch. So every check after a
    // finished install re-discovers the release that is already sitting on
    // disk, and puts the app back to `available`: the Restart button turns into
    // an Update button, and pressing it downloads and swaps in the same release
    // again. REPORTED as an update that installs itself endlessly, which is
    // literally what it did — once per press, forever, until the user
    // restarted and the running version finally caught up.
    if (this.state.phase === 'ready') {
      return this.state;
    }
    const deadline = this.deps.checkDeadlineMs ?? CHECK_DEADLINE_MS;
    const attempt = this.begin(deadline, checkTimedOut(deadline));
    try {
      if (announce) {
        this.emit({ phase: 'checking', message: null, progress: null });
      }
      const lookup = await this.deps.fetchLatest();
      if (this.abandoned(attempt)) {
        return this.state;
      }
      if (!lookup.ok) {
        this.deps.log('warn', `the update check failed: ${lookup.error}`, {
          kind: 'update-check-failed',
        });
        return this.emit({ phase: 'error', message: lookup.error });
      }
      const { release } = lookup;
      const current = this.deps.currentVersion();
      if (!isNewerVersion(release.version, current)) {
        this.release = null;
        // "Up to date" is only half true when a NEWER tag is published whose
        // macOS archive has not been uploaded yet: this app is on the latest it
        // can install, and a version it cannot install exists. Reported as
        // "terminal not saying truth — there is a new version", and the release
        // side of the same race is what `26e2e6f` fixed in the workflow.
        //
        // Still `up-to-date` rather than `available`: nothing here is
        // downloadable, so a phase that offers an Update button would put a
        // control on screen with nothing behind it. The phase says what the app
        // can do; the message says what the world looks like.
        const pending =
          lookup.published !== null && isNewerVersion(lookup.published, current)
            ? lookup.published
            : null;
        return this.emit({
          phase: 'up-to-date',
          version: current,
          message:
            pending === null
              ? null
              : `Geniro ${pending} is published, but its macOS build has not been uploaded yet.`,
        });
      }
      this.release = release;
      const canInstall = await this.resolveCanInstall();
      if (this.abandoned(attempt)) {
        return this.state;
      }
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
      this.settle(attempt);
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
    // `error` and not `available` alone: the rail's Retry control IS this call,
    // and an install that failed — or one the watchdog abandoned — leaves the
    // phase at `error` with the offered release still held. Refusing it here is
    // what made that button do nothing but restate its own refusal.
    const offered =
      this.state.phase === 'available' || this.state.phase === 'error';
    if (!release || !offered) {
      return this.emit({
        phase: 'error',
        message: 'there is no update ready to install',
      });
    }
    // Latched SYNCHRONOUSLY, before the first await. Set after it, two presses
    // a few milliseconds apart both pass the check and start their own
    // download of the same release into the same scratch directory.
    const stall = this.deps.downloadStallMs ?? DOWNLOAD_STALL_MS;
    const attempt = this.begin(stall, downloadStalled(stall));
    const aborter = new AbortController();
    this.aborter = aborter;
    try {
      const bundlePath = this.deps.bundlePath();
      if (!bundlePath || !(await this.resolveCanInstall())) {
        return this.emit({
          phase: 'error',
          message: `this copy of Geniro cannot replace itself — update with: ${UPDATE_COMMAND}`,
        });
      }
      if (this.abandoned(attempt)) {
        return this.state;
      }
      this.deps.log('info', `downloading Geniro ${release.version}`, {
        kind: 'update-install-started',
        version: release.version,
      });
      this.emit({ phase: 'downloading', progress: 0, message: null });
      await this.deps.install({
        release,
        bundlePath,
        workDir: this.deps.workDir(),
        signal: aborter.signal,
        onStage: (stage) => {
          if (this.abandoned(attempt) || stage !== 'installing') {
            return;
          }
          // A different budget for a different kind of wait: `ditto` reports
          // nothing at all, so there is no stall to detect — only a total.
          const deadline = this.deps.installDeadlineMs ?? INSTALL_DEADLINE_MS;
          this.armWatchdog(attempt, deadline, installTimedOut(deadline));
          this.emit({ phase: 'installing', progress: null });
        },
        onProgress: ({ fraction }) => {
          if (this.abandoned(attempt)) {
            return;
          }
          // Re-armed off the RAW callback rather than off an emitted change: a
          // server that declares no content-length leaves `fraction` null for
          // the whole transfer, so a watchdog fed by the published `progress`
          // would give up on a download that was streaming perfectly.
          this.armWatchdog(attempt, stall, downloadStalled(stall));
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
      if (this.abandoned(attempt)) {
        return this.state;
      }
    } catch (err) {
      if (this.abandoned(attempt)) {
        // The abort THIS service raised, surfacing as the rejection it was
        // meant to cause. The watchdog has already said what happened, in
        // words about the stall rather than about an AbortError.
        return this.state;
      }
      const message = `${err instanceof Error ? err.message : String(err)} — you can still update with: ${UPDATE_COMMAND}`;
      this.deps.log(
        'error',
        `the update to ${release.version} failed: ${message}`,
        {
          kind: 'update-install-failed',
          version: release.version,
        },
      );
      return this.emit({ phase: 'error', progress: null, message });
    } finally {
      // Released on EVERY path out of the try, including the early returns:
      // leaving it latched would refuse every further check and press for the
      // rest of the launch.
      this.settle(attempt);
    }
    this.deps.log(
      'info',
      `Geniro ${release.version} is installed — waiting for a restart`,
      { kind: 'update-installed', version: release.version },
    );
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
   * Remove what previous updates left on disk. At LAUNCH, and nowhere else.
   *
   * REPORTED: ~224MB of dead trees — two scratch directories under `updates/`
   * and two `Geniro.app.old-*` backups beside the app — from updates that had
   * SUCCEEDED days earlier, each eroded down to a `Contents/Resources` the
   * cleanup had not finished emptying. Neither is a missing step: the install
   * discards its scratch in a `finally` and its backup on the way out of the
   * swap. Both are deliberately best-effort, because a cleanup that throws
   * turned a completed update into "The update could not be installed" — and a
   * freshly-written bundle is exactly what macOS holds open behind them.
   *
   * So the guarantee cannot live inside the install at all. It lives here, at
   * the one moment nothing in this file is running, which is also the only
   * thing that reaches debris from a launch that never updates again.
   */
  async sweepDebris(): Promise<string[]> {
    const bundlePath = this.deps.bundlePath();
    // `busy` is belt and braces — this runs before anything can have started —
    // but sweeping `update-*` out from under a live download would delete the
    // scratch directory that download is writing into.
    if (!this.deps.isPackaged() || !bundlePath || this.busy) {
      return [];
    }
    const removed = await this.deps.sweep({
      workDir: this.deps.workDir(),
      bundlePath,
    });
    if (removed.length > 0) {
      this.deps.log(
        'info',
        `removed ${removed.length} leftover update file(s): ${removed.join(', ')}`,
        { kind: 'update-debris-swept', count: String(removed.length) },
      );
    }
    return removed;
  }

  /**
   * Claim the service for one attempt, and arm the deadline it has to beat.
   *
   * The latch and the counter move together, because they answer two halves of
   * one question: `busy` is "may something else start", `attempt` is "is this
   * still the thing that may finish".
   */
  private begin(deadlineMs: number, timedOut: string): number {
    this.busy = true;
    this.attempt += 1;
    this.armWatchdog(this.attempt, deadlineMs, timedOut);
    return this.attempt;
  }

  /** Has this attempt been given up on — by the watchdog, or by a later one? */
  private abandoned(attempt: number): boolean {
    return attempt !== this.attempt;
  }

  /**
   * Release the service — unless this attempt was already abandoned, in which
   * case a newer one owns the latch and the deadline and neither is ours to
   * clear.
   */
  private settle(attempt: number): void {
    if (this.abandoned(attempt)) {
      return;
    }
    this.disarmWatchdog();
    this.aborter = null;
    this.busy = false;
  }

  /**
   * Bound the phase in flight.
   *
   * Re-arming is how the download's stall budget works, so this always clears
   * the previous timer first: two live watchdogs over one attempt would mean
   * the first one's deadline still firing long after progress resumed.
   */
  private armWatchdog(attempt: number, ms: number, timedOut: string): void {
    this.disarmWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.abandoned(attempt)) {
        return;
      }
      // Abandon it — bumping the counter is what makes every guard in the
      // attempt fail — and CANCEL it, which is the half that matters once the
      // user can retry over the top of whatever is still running.
      this.attempt += 1;
      this.busy = false;
      this.aborter?.abort(new Error(timedOut));
      this.aborter = null;
      this.deps.log('error', timedOut, {
        kind: 'update-timed-out',
        phase: this.state.phase,
      });
      this.emit({ phase: 'error', progress: null, message: timedOut });
    }, ms);
    // Never the reason this process stays alive.
    this.watchdog.unref?.();
  }

  private disarmWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
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

  /**
   * Merge a patch into the state and push it at every window — unless nothing
   * about it changed.
   *
   * The patch is always a fresh object, so without this comparison "the state
   * did not change" and "the state changed" are the same event as far as the
   * renderer is concerned: `setState` on a new identity re-renders whether or
   * not the value differs. A scheduled check on an up-to-date app produced
   * exactly that — `up-to-date` written over `up-to-date`, every five minutes,
   * re-rendering the app to say the same sentence. The state is six flat
   * fields, so identity of value is the whole question and a shallow compare
   * answers it.
   */
  private emit(
    patch: Partial<UpdateState> & { phase?: UpdatePhase },
  ): UpdateState {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(next) as (keyof UpdateState)[]).some(
      (key) => next[key] !== this.state[key],
    );
    this.state = next;
    if (changed) {
      this.deps.broadcast(this.state);
    }
    return this.state;
  }
}

/** The production service, wired to electron and the real network/filesystem. */
export function createUpdateService(log: UpdateLog): UpdateService {
  return new UpdateService({
    currentVersion: () => app.getVersion(),
    isPackaged: () => app.isPackaged,
    bundlePath: () => resolveBundlePath(app.getPath('exe')),
    workDir: () => join(app.getPath('userData'), 'updates'),
    fetchLatest: fetchLatestRelease,
    install: installUpdate,
    canWrite: canWriteBundle,
    sweep: sweepUpdateDebris,
    log,
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
