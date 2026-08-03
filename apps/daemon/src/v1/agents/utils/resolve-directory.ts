import { realpathSync, statSync } from 'node:fs';
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
  return canonical;
}
