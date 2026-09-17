import { opendirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { BadRequestException } from '@packages/common';

/**
 * Validate a directory path and return its canonical (symlink-resolved)
 * absolute form.
 *
 * The three checks — absolute, exists, is a directory — are shared by every
 * caller-supplied path the daemon hands a spawned CLI, so they live here once
 * rather than being re-derived per call site. Each caller supplies its own
 * error code and noun so the refusal names the field the user actually set.
 *
 * Canonicalizing closes the gap where a symlinked path is persisted
 * un-resolved; the returned path is what gets stored and spawned with.
 *
 * Deliberately NOT an allowed-root check. Confining these paths to a root is
 * out of scope for the local-first single-user model — the user picks their
 * own folders on their own machine — and it would break the ordinary case of
 * a plugin living under the home directory.
 */
export function resolveValidDirectory(
  path: string,
  options: { errorCode: string; noun: string },
): string {
  const { errorCode, noun } = options;
  if (!isAbsolute(path)) {
    throw new BadRequestException(
      errorCode,
      `${noun} must be an absolute path (starting with /)`,
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync(path); // resolves symlinks; throws if missing
  } catch {
    throw new BadRequestException(errorCode, `${noun} does not exist: ${path}`);
  }
  if (!statSync(canonical).isDirectory()) {
    throw new BadRequestException(
      errorCode,
      `${noun} is not a directory: ${path}`,
    );
  }
  assertReadable(canonical, path, noun);
  return canonical;
}

/**
 * Refuse a directory the daemon cannot LIST, with a sentence that says why.
 *
 * `realpath` and `stat` both succeed on a folder macOS privacy protection
 * (TCC) has denied, and so does `access(R_OK)`: only opening it fails, with
 * `EPERM`. Measured on 2026-09-14, a Desktop project after Geniro lost its
 * Desktop grant. Every check above passed, and claude, started there, exited
 * in 4ms with `error: An unknown error occurred (Unexpected)`. REPORTED as a
 * workflow whose Manager failed on every message with that line and nothing
 * saying what to do.
 *
 * Its own code rather than the caller's: the renderer answers `INVALID_CWD` on
 * a task run by rebuilding the task's worktree (`task-worktree.ts`), which is
 * the wrong repair for a folder that exists and is simply not readable.
 */
function assertReadable(canonical: string, path: string, noun: string): void {
  try {
    opendirSync(canonical).closeSync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') {
      throw new BadRequestException(
        'FOLDER_NOT_READABLE',
        `macOS is not letting Geniro read this ${noun}: ${path}. Allow Geniro in System Settings → Privacy & Security → Files and Folders (or Full Disk Access), then try again.`,
      );
    }
    if (code === 'EACCES') {
      throw new BadRequestException(
        'FOLDER_NOT_READABLE',
        `${noun} is not readable by your user: ${path}`,
      );
    }
    // Anything else says nothing about access, so it decides nothing here —
    // the CLI started in the folder reports its own failure.
  }
}
