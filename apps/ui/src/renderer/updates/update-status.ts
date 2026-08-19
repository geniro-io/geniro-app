import { UPDATE_COMMAND, type UpdateState } from '../../shared/contracts';

/**
 * One sentence for an update state, shared by the strip and the Settings row.
 *
 * Two surfaces show this and they must not word it differently: the banner is
 * what a user sees mid-download and Settings is where they go to check on it,
 * so the same phase reading "Installing…" in one place and "Working…" in the
 * other would read as two different things happening.
 *
 * The message is appended by the caller where there is one — it carries main's
 * own words (the checksum that did not match), which this cannot compose.
 */
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
            title: state.message
              ? `${updateStatusLine(state)} ${state.message}`
              : updateStatusLine(state),
          }
        : { kind: 'none' };
    default:
      // `idle` / `checking` / `up-to-date` — nothing to offer. A check in
      // flight deliberately shows nothing: it happens on launch and every 6h
      // without being asked, and a spinner appearing in the status row on its
      // own schedule is motion the user cannot explain.
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
      return 'The update could not be installed.';
    default:
      // `idle` — nothing has been checked yet this launch. In a dev build that
      // is permanent, and main's message says so.
      return '';
  }
}
