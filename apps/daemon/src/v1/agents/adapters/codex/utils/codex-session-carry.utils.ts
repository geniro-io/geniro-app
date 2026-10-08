import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import type { CarrySessionResult } from '../../adapter.types';
import { CODEX_THREAD_ID_PATTERN } from '../codex.const';

/**
 * Copy the rollout codex's `thread/read` located into another home. Probed on
 * 0.161.0: `thread/resume` in the target reopens the same id and full history
 * after this copy, without copying credentials or the source's SQLite index.
 * On a return to a previous home, only an older prefix may be replaced; a
 * newer continuation is kept and divergent histories are refused.
 */
export async function carryCodexSession(input: {
  sessionId: string;
  sourcePath: string;
  fromHome: string;
  toHome: string;
}): Promise<CarrySessionResult> {
  try {
    const from = await realpath(input.fromHome);
    const source = await realpath(input.sourcePath);
    const location = relative(from, source);
    const store = location.split(sep)[0];
    if (
      !CODEX_THREAD_ID_PATTERN.test(input.sessionId) ||
      !['sessions', 'archived_sessions'].includes(store ?? '') ||
      !basename(source).endsWith(`-${input.sessionId}.jsonl`)
    ) {
      return {
        carried: false,
        reason: 'codex did not locate this thread inside the previous home',
      };
    }
    await mkdir(input.toHome, { recursive: true });
    const to = await realpath(input.toHome);
    const target = join(to, location);
    if (source === target) {
      return { carried: true };
    }
    await mkdir(dirname(target), { recursive: true });
    // A sessions-directory symlink must not redirect the copy outside the
    // selected home. The home itself may legitimately be a symlink.
    const targetDirectory = relative(to, await realpath(dirname(target)));
    if (targetDirectory.split(sep)[0] !== store) {
      return {
        carried: false,
        reason: 'the new home redirects its session store outside that home',
      };
    }
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL);
      return { carried: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    const before = await lstat(target);
    if (!before.isFile()) {
      return {
        carried: false,
        reason: 'the new home already holds a non-file at this rollout path',
      };
    }
    const [latest, existing] = await Promise.all([
      readFile(source),
      readFile(target),
    ]);
    const shared = Math.min(latest.length, existing.length);
    if (!latest.subarray(0, shared).equals(existing.subarray(0, shared))) {
      return {
        carried: false,
        reason: 'the two homes hold different continuations of this thread',
      };
    }
    if (existing.length >= latest.length) {
      return { carried: true };
    }
    const temporary = join(
      dirname(target),
      `.geniro-carry-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, latest, { flag: 'wx', mode: before.mode });
      const current = await lstat(target);
      if (
        current.ino !== before.ino ||
        current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs
      ) {
        return {
          carried: false,
          reason:
            'the thread changed in the new home while it was being copied',
        };
      }
      await rename(temporary, target);
      return { carried: true };
    } finally {
      await rm(temporary, { force: true });
    }
  } catch (error) {
    return {
      carried: false,
      reason: `the thread could not be copied into the new home: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
