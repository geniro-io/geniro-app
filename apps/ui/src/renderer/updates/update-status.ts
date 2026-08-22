import { UPDATE_COMMAND, type UpdateState } from '../../shared/contracts';

/**
 * What the nav rail's version row offers for an update, if anything.
 *
 * The app-wide strip that used to carry this is GONE — it and this row were two
 * controls for one action, stacked in the same window, and the strip was the one
 * that had to interrupt a view to say something the version row was already the
 * natural home for. So this row is now the ONLY channel, which is what makes
 * every phase below load-bearing rather than decorative: with the strip present
 * a phase this row skipped was still reported somewhere, and now it is not.
 *
 * Pure and separate from the markup for the same reason `updateStatusLine` is —
 * the rules are the interesting part, and they are what a spec can hold still.
 *
 * `label` is deliberately terse. It shares one 220px row with the version, the
 * status dot and the debug trigger, so this is a glyph plus at most a version or
 * a percentage; the full sentence rides `title` and lives in Settings.
 */
export type FooterUpdate =
  | { kind: 'none' }
  /** An offer this install can actually apply — pressing it starts the download. */
  | { kind: 'install'; label: string; title: string }
  /** A download or swap already running. Not pressable: it is already happening. */
  | { kind: 'progress'; label: string; title: string }
  /** Installed and waiting — pressing it restarts into the new bundle. */
  | { kind: 'restart'; label: string; title: string }
  /** An install the user STARTED and which failed; pressing it tries again. */
  | { kind: 'error'; label: string; title: string }
  /**
   * An offer this install CANNOT apply — a Homebrew install, a translocated
   * quarantine copy. Not pressable: `title` carries the command that DOES
   * work rather than a button that would fail at the last step. Without this
   * kind such a copy fell all the way to `none` and lost its only remaining
   * channel besides opening Settings.
   */
  | { kind: 'readout'; label: string; title: string };

export function footerUpdate(
  state: UpdateState | null,
  /**
   * Whether the user has pressed something here this launch.
   *
   * Only an install they STARTED earns the error state. A failed background
   * CHECK — GitHub unreachable on a train — is not something they asked about
   * or can act on, and putting a warning glyph in the shell's status row for it
   * would report the network as an app fault.
   */
  engaged: boolean,
): FooterUpdate {
  if (!state) {
    return { kind: 'none' };
  }
  switch (state.phase) {
    case 'available':
      // `canInstall` is main's answer about THIS install — a read-only volume,
      // another account's copy, a translocated quarantine copy. Where it is
      // false the update is real but this app cannot apply it, so the row is a
      // non-pressable readout naming the command that DOES work rather than a
      // button that would fail at the last step.
      return state.canInstall
        ? {
            kind: 'install',
            label: state.version ?? 'update',
            title: `Update to Geniro ${state.version}`,
          }
        : {
            kind: 'readout',
            label: state.version ?? 'update',
            // main's own words when it has them; UPDATE_COMMAND covers the
            // one case main sent none, so this can never fall back to silence.
            title: state.message ?? `Update with: ${UPDATE_COMMAND}`,
          };
    case 'downloading':
      return {
        kind: 'progress',
        // A percentage only once there is one to state. `progress` is null
        // until the first chunk lands, and "0%" for a download that has begun
        // reads as one that is stuck.
        label:
          state.progress === null
            ? 'updating'
            : `${Math.round(state.progress * 100)}%`,
        title: updateStatusLine(state),
      };
    case 'installing':
      return {
        kind: 'progress',
        label: 'installing',
        title: updateStatusLine(state),
      };
    case 'ready':
      return {
        kind: 'restart',
        label: 'restart',
        title: updateStatusLine(state),
      };
    case 'error':
      return engaged
        ? {
            kind: 'error',
            label: 'retry',
            // main's own words (the checksum that did not match, the command
            // for an install the app cannot replace) — never re-worded here.
            title: updateStatusText(state),
          }
        : { kind: 'none' };
    default:
      // `idle` / `checking` / `up-to-date` — nothing to offer. A check in
      // flight deliberately shows nothing: it happens on launch and every few
      // minutes without being asked, and a spinner appearing in the status row
      // on its own schedule is motion the user cannot explain.
      return { kind: 'none' };
  }
}

export function updateStatusLine(state: UpdateState): string {
  switch (state.phase) {
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return `Up to date (v${state.currentVersion}).`;
    case 'available':
      return `Geniro ${state.version} is available.`;
    case 'downloading':
      return `Downloading Geniro ${state.version}…`;
    case 'installing':
      return `Installing Geniro ${state.version}…`;
    case 'ready':
      // Not "restarting…". The app deliberately does not restart itself — the
      // restart takes the daemon and every running turn with it — so this is a
      // standing state waiting on the Restart button, and an ellipsis would
      // promise something that is never going to happen on its own.
      return `Geniro ${state.currentVersion} is installed — restart to use it.`;
    case 'error':
      // WHICH phase failed, from the state rather than assumed. Every failure
      // used to read "The update could not be installed.", which was REPORTED
      // against a download that never moved a byte — an app that had installed
      // nothing being told the install had failed. The three are not the same
      // news: a failed check is usually the network, a stalled download is a
      // worse case of it, and only the third has touched the bundle.
      switch (state.failedPhase) {
        case 'checking':
          return 'The update check failed.';
        case 'downloading':
          return 'The download failed.';
        default:
          // `installing`, and the null a pre-`failedPhase` state carries.
          return 'The update could not be installed.';
      }
    default:
      // `idle` — nothing has been checked yet this launch. In a dev build that
      // is permanent, and main's message says so.
      return '';
  }
}

/**
 * The whole thing a surface says about an update: the phase's own sentence,
 * plus main's message when there is one.
 *
 * ONE composition, because there are two surfaces and they were joining the
 * pair themselves — the nav rail's hover title and the Settings line — so the
 * defect REPORTED against Settings ("The update could not be installed. the
 * update made no progress for 3 minutes") was present in both and fixable in
 * neither without fixing the other.
 *
 * Never re-words main's own text — the checksum that did not match and the
 * command for an install the app cannot replace are main's to say; all this
 * decides is the punctuation between the two halves.
 */
export function updateStatusText(state: UpdateState): string {
  const line = updateStatusLine(state);
  if (!state.message) {
    return line;
  }
  if (!line) {
    return state.message;
  }
  // main writes an ERROR's message as a FRAGMENT meant to follow a lead ("fetch
  // failed", "it made no progress for 3 minutes"), and every other phase's as a
  // whole sentence ("Geniro 1.5.0 is published, but…"). So the error joins with
  // a colon and the rest with a space.
  //
  // Capitalizing the fragment instead was tried and is WRONG: these carry
  // acronyms, shell commands and absolute paths, so it produced "Ipc broke" out
  // of a real one. The defect being fixed here is the same seam failing the
  // other way — the REPORTED "The update could not be installed. the update
  // made no progress for 3 minutes", a lowercase fragment after a full stop.
  return state.phase === 'error'
    ? `${line.replace(/\.$/, '')}: ${state.message}`
    : `${line} ${state.message}`;
}
