import { constants, realpathSync } from 'node:fs';
import { type FileHandle, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import type { HostPatch, HostPatchOutcome } from '../chat.types';
import { writeContainment } from './write-containment';

/**
 * Write a patch the user has ACCEPTED, or say why it could not be written.
 *
 * This is the only place in the render family that touches the user's disk, so
 * it is written to be boring and suspicious in equal measure. Two rules do the
 * real work:
 *
 * **The write must land inside the run's own cwd.** That is the folder the user
 * pointed this chat at, and it is the whole scope they consented to. Checked by
 * `writeContainment` — lexically AND on real paths, because a lexical check
 * alone is satisfied by a symlink that sits inside the folder and points
 * anywhere at all — and handed the path this function actually WRITES, which
 * `resolve` has already collapsed, so a `link/..` is judged where it lands.
 *
 * **A patch with an `oldString` must match EXACTLY ONCE.** Zero matches means
 * the file moved on since the agent read it. More than one means the agent
 * named a fragment that appears again elsewhere, and picking the first is a
 * coin flip on which of them the user actually saw in the diff. Both refuse.
 *
 * Never throws: every failure is an outcome, because the caller is answering a
 * model over MCP and a stack trace is not an answer. Filesystem errors are
 * reported by their `code` alone — an `ENOENT` message carries the absolute
 * path, and the string this returns is handed to a model whose provider is off
 * this machine.
 */
export async function applyHostPatch(
  cwd: string,
  patch: HostPatch,
): Promise<HostPatchOutcome> {
  const target = resolve(cwd, patch.filePath);
  const refused = containmentRefusal(cwd, target);
  if (refused !== null) {
    return refused;
  }

  if (patch.oldString === undefined) {
    // No search text: this is `Write`'s shape — a new file, or a deliberate
    // whole-file replacement. The user saw the entire body as additions.
    try {
      await mkdir(dirname(target), { recursive: true });
    } catch (err) {
      return {
        status: 'stale',
        reason: `the file could not be written (${codeOf(err)})`,
      };
    }
    return writeContained(cwd, target, patch.newString, patch.filePath);
  }

  let current: string;
  try {
    current = await readFile(target, 'utf8');
  } catch (err) {
    return {
      status: 'stale',
      reason:
        codeOf(err) === 'ENOENT'
          ? 'the file does not exist'
          : `the file could not be read (${codeOf(err)})`,
    };
  }
  const first = current.indexOf(patch.oldString);
  if (first === -1) {
    return {
      status: 'stale',
      reason: 'the text to replace is no longer in the file',
    };
  }
  if (current.indexOf(patch.oldString, first + 1) !== -1) {
    return {
      status: 'stale',
      reason:
        'the text to replace appears more than once — include enough surrounding lines to name one place',
    };
  }
  const next =
    current.slice(0, first) +
    patch.newString +
    current.slice(first + patch.oldString.length);
  return writeContained(cwd, target, next, patch.filePath);
}

const LINK_OUT = 'the path resolves outside this chat’s folder through a link';

/** The refusal a path's containment earns, or null when it lands inside. */
function containmentRefusal(
  cwd: string,
  target: string,
): HostPatchOutcome | null {
  const containment = writeContainment(cwd, target);
  if (containment === 'outside') {
    return {
      status: 'stale',
      reason: 'the path is outside this chat’s folder',
    };
  }
  if (containment === 'through-link') {
    return { status: 'stale', reason: LINK_OUT };
  }
  return null;
}

/**
 * Write `content` to `target`, judged again at the moment of the write.
 *
 * The check at the top of `applyHostPatch` is separated from the write by
 * awaits — a directory made, a file read — and a link planted in between (by
 * a background command the agent started, say) would carry an accepted write
 * out of the folder. So containment is judged again here; an existing file is
 * opened at its REAL path, with no link at its own name followed — a link
 * inside the folder is still written through, one planted after this check
 * refuses the open; and a file with other hard links is refused, since every
 * check above reads a hard link as an ordinary file and writing it writes the
 * file it shares.
 */
async function writeContained(
  cwd: string,
  target: string,
  content: string,
  filePath: string,
): Promise<HostPatchOutcome> {
  const refused = containmentRefusal(cwd, target);
  if (refused !== null) {
    return refused;
  }
  let handle: FileHandle;
  try {
    handle = await open(
      realPathOrSelf(target),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o666,
    );
  } catch (err) {
    return {
      status: 'stale',
      reason:
        codeOf(err) === 'ELOOP'
          ? LINK_OUT
          : `the file could not be written (${codeOf(err)})`,
    };
  }
  try {
    if ((await handle.stat()).nlink > 1) {
      return {
        status: 'stale',
        reason:
          'the file has other hard links, so writing it could change a file outside this chat’s folder',
      };
    }
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
  } catch (err) {
    return {
      status: 'stale',
      reason: `the file could not be written (${codeOf(err)})`,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { status: 'applied', path: relative(cwd, target) || filePath };
}

/** An existing path with every link resolved, or the path itself for a new one. */
function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A filesystem error's `code`, which is safe to hand to a model. */
function codeOf(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : 'unknown error';
}
