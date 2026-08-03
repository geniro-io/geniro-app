import { resolveValidDirectory } from './resolve-directory';

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
  return resolveValidDirectory(cwd, { errorCode: 'INVALID_CWD', noun: 'cwd' });
}
