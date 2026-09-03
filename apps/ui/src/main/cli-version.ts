import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CliKind } from '../shared/contracts';
import { probeEnv } from './probe-env';

const execFileAsync = promisify(execFile);

/**
 * What version one CLI binary reports for itself, or null when it could not be
 * asked.
 *
 * Its own module, small as it is, because it has TWO readers and they must not
 * be allowed to answer differently: `cli-detect.ts` puts this figure on the
 * card, and `cli-update.ts` reads it either side of an update to say what
 * changed — a comparison that means nothing unless both sides come from the
 * same reader. Kept out of either of those files to avoid an import cycle
 * between them; the same shape `resolve-binary.ts` and `probe-env.ts` already
 * take beside it.
 *
 * The FIRST line only: a CLI is free to print a banner under its version, and
 * the figure is what a reader compares.
 */
export async function probeVersion(
  kind: CliKind,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(path, ['--version'], {
      timeout: 5000,
      env: probeEnv(kind),
    });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}
