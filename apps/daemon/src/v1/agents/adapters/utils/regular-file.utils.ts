import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

/** Whether `path` is a directory itself, not a symlink to one. */
export async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A regular file's text, or null for anything else: the file is opened without
 * following a symlink and checked on the open handle, so it cannot be swapped
 * between the check and the read, nor wait on a FIFO; a file hard-linked from
 * elsewhere, over `maxBytes`, or grown since it was checked, is refused too.
 */
export async function readRegularFile(
  path: string,
  maxBytes: number,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }
  try {
    const found = await handle.stat();
    if (!found.isFile() || found.nlink !== 1 || found.size > maxBytes) {
      return null;
    }
    const buffer = Buffer.alloc(Math.min(found.size, maxBytes) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        filled,
      );
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    return filled === buffer.length ? null : buffer.toString('utf8', 0, filled);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
