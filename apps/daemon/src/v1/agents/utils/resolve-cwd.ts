import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { BadRequestException } from '@packages/common';

/**
 * Validate a working directory and return its canonical (symlink-resolved)
 * absolute path. Canonicalizing closes the gap where a symlinked cwd is
 * persisted un-resolved; the returned path is what gets stored and spawned in.
 * The agent is scoped to the user's chosen folder (it never defaults to the
 * daemon's own cwd, the app repo) — confining it further to an allowed root is
 * out of scope for the local-first single-user model (the user picks their own
 * project folder on their own machine).
 */
export function resolveValidCwd(cwd: string): string {
  if (!isAbsolute(cwd)) {
    throw new BadRequestException(
      'INVALID_CWD',
      'cwd must be an absolute path',
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync(cwd); // resolves symlinks; throws if missing
  } catch {
    throw new BadRequestException('INVALID_CWD', `cwd does not exist: ${cwd}`);
  }
  if (!statSync(canonical).isDirectory()) {
    throw new BadRequestException(
      'INVALID_CWD',
      `cwd is not a directory: ${cwd}`,
    );
  }
  return canonical;
}
