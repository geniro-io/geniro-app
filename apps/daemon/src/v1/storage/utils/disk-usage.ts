import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { SeenInodes } from '../storage.types';

const BLOCK_BYTES = 512;
const YIELD_EVERY_ENTRIES = 500;

export function newSeenInodes(): SeenInodes {
  return new Set();
}

/**
 * Space a file or directory tree takes on disk, in bytes: allocated blocks,
 * not apparent length, never following a symlink. A path that vanishes or
 * cannot be read mid-walk counts as nothing rather than failing the scan.
 */
export async function measurePath(
  path: string,
  seen: SeenInodes = newSeenInodes(),
): Promise<number> {
  let total = 0;
  let visited = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const info = await lstat(current).catch(() => null);
    if (info === null) {
      continue;
    }
    const key = `${info.dev}:${info.ino}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    total += info.blocks * BLOCK_BYTES;
    if (info.isDirectory()) {
      const names = await readdir(current).catch(() => [] as string[]);
      for (const name of names) {
        stack.push(join(current, name));
      }
    }
    visited += 1;
    if (visited % YIELD_EVERY_ENTRIES === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return total;
}

/** The names directly inside a directory; empty when it does not exist. */
export async function listNames(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}
