import type { UpdateState } from '../../shared/contracts';

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
      return 'Update installed — restarting Geniro…';
    case 'error':
      return 'The update could not be installed.';
    default:
      // `idle` — nothing has been checked yet this launch. In a dev build that
      // is permanent, and main's message says so.
      return '';
  }
}
