import { realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { app, shell } from 'electron';

/** The one directory a renderer-supplied path is allowed to point into. */
const LOG_DIR_NAME = 'logs';

/**
 * Show the daemon's log file in Finder.
 *
 * It REVEALS rather than opens — `showItemInFolder` selects the file in the
 * file manager and never hands it to LaunchServices, so a path this is talked
 * into taking cannot become a program that runs. That matters because the
 * argument comes from the sandboxed renderer: the daemon is where the path
 * originates, but the renderer is what passes it on, and a compromised one
 * would be the thing calling this.
 *
 * On top of that it is CONFINED to `<userData>/logs`, resolved through
 * `realpath` first so `../` and a symlink planted inside the directory both
 * fail the check rather than escape it. A refusal comes back as a reason, not
 * a throw: the button is a convenience, and the panel already shows the path
 * as text for anyone who wants to go there themselves.
 */
export function revealPath(target: string): {
  revealed: boolean;
  reason: string | null;
} {
  let logDir: string;
  try {
    // The BOUNDARY is realpath'd too. Compared against a non-canonical root,
    // a canonical target would never match on a machine where any parent is a
    // symlink — on macOS `/var` is one — and the feature would simply refuse
    // every path.
    logDir = realpathSync(join(app.getPath('userData'), LOG_DIR_NAME));
  } catch {
    return {
      revealed: false,
      reason: 'the daemon has not written a log file yet',
    };
  }
  let canonical: string;
  try {
    canonical = realpathSync(resolve(target));
  } catch {
    return { revealed: false, reason: 'that file no longer exists' };
  }
  // The trailing separator is what stops a sibling directory whose name merely
  // STARTS with the log dir's (`…/logsofsomethingelse`) from passing.
  if (!canonical.startsWith(logDir + sep)) {
    return {
      revealed: false,
      reason: 'only the daemon’s own log files can be revealed',
    };
  }
  shell.showItemInFolder(canonical);
  return { revealed: true, reason: null };
}
