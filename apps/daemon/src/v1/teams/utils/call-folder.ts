import { join, relative, resolve } from 'node:path';

import { BadRequestException } from '@packages/common';

import { isWithinDirectory } from '../../agents/utils/path-within';
import { existingDirectory } from '../../agents/utils/resolve-directory';

/**
 * A `call_agent` folder read against the run's folder: `folder` is the
 * subfolder relative to the run's canonical folder (null for the run's folder
 * itself), `path` its canonical absolute form.
 */
export type CallFolderReading =
  { folder: string | null; path: string } | { refused: string };

/**
 * Read the folder a caller asked a callee to run in, against the run's folder
 * `root`. Only an existing directory inside `root` is taken, judged twice: by
 * the path as written (a `..` or an absolute path elsewhere) and by where its
 * links really lead, so a symlink inside the folder cannot carry a callee out.
 */
export function readCallFolder(
  root: string | null | undefined,
  requested: string,
): CallFolderReading {
  if (root === null || root === undefined) {
    return {
      refused:
        'FOLDER_UNAVAILABLE: this run has no folder, so a member cannot be started in a subfolder of it',
    };
  }
  const base = existingDirectory(root);
  if (base === null) {
    return {
      refused: `FOLDER_UNAVAILABLE: this run's folder ${root} no longer exists`,
    };
  }
  const written = resolve(base, requested);
  if (
    !isWithinDirectory(written, base) &&
    !isWithinDirectory(written, resolve(root))
  ) {
    return {
      refused: `FOLDER_OUTSIDE: '${requested}' is outside this chat's folder ${base} — pass a subfolder of it`,
    };
  }
  const path = existingDirectory(written);
  if (path === null) {
    return {
      refused: `FOLDER_NOT_FOUND: '${requested}' is not an existing, readable folder inside ${base}`,
    };
  }
  if (!isWithinDirectory(path, base)) {
    return {
      refused: `FOLDER_OUTSIDE: '${requested}' leads through a link to outside this chat's folder ${base}`,
    };
  }
  const folder = relative(base, path);
  return { folder: folder === '' ? null : folder, path };
}

/**
 * The folder a callee turn starts in: `folder` (relative, as the broker
 * recorded it) under the run's folder `root` as it stands now, checked again
 * because the disk may have changed since the call was made.
 */
export function callTurnFolder(root: string, folder: string): string {
  const reading = readCallFolder(root, folder);
  if ('refused' in reading) {
    throw new BadRequestException('CALL_FOLDER_UNAVAILABLE', reading.refused);
  }
  return reading.path;
}

/** Where a callee's `folder` would sit under `root`, read from the path alone. */
export function callFolderPath(root: string, folder: string | null): string {
  return folder === null ? root : join(root, folder);
}
