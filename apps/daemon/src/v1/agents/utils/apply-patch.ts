import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import type { HostPatch, HostPatchOutcome } from '../chat.types';

/**
 * Write a patch the user has ACCEPTED, or say why it could not be written.
 *
 * This is the only place in the render family that touches the user's disk, so
 * it is written to be boring and suspicious in equal measure. Two rules do the
 * real work:
 *
 * **The write must land inside the run's own cwd.** That is the folder the user
 * pointed this chat at, and it is the whole scope they consented to. Checked
 * TWICE — once lexically on the resolved path, and once on the real path of the
 * containing directory, because a lexical check alone is satisfied by a symlink
 * that sits inside the folder and points anywhere at all.
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
  if (!isInside(cwd, target)) {
    return {
      status: 'stale',
      reason: 'the path is outside this chat’s folder',
    };
  }
  // The real path of the PARENT, not of the file: the file may legitimately not
  // exist yet, and it is the directory chain that a symlink would redirect.
  const parent = dirname(target);
  if (!isInside(await realNearest(cwd), await realNearest(parent))) {
    return {
      status: 'stale',
      reason: 'the path resolves outside this chat’s folder through a link',
    };
  }

  if (patch.oldString === undefined) {
    // No search text: this is `Write`'s shape — a new file, or a deliberate
    // whole-file replacement. The user saw the entire body as additions.
    try {
      await mkdir(parent, { recursive: true });
      await writeFile(target, patch.newString, 'utf8');
    } catch (err) {
      return {
        status: 'stale',
        reason: `the file could not be written (${codeOf(err)})`,
      };
    }
    return { status: 'applied', path: relative(cwd, target) || patch.filePath };
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
  try {
    await writeFile(target, next, 'utf8');
  } catch (err) {
    return {
      status: 'stale',
      reason: `the file could not be written (${codeOf(err)})`,
    };
  }
  return { status: 'applied', path: relative(cwd, target) || patch.filePath };
}

/** Whether `child` is `parent` itself or sits beneath it. */
function isInside(parent: string, child: string): boolean {
  if (child === parent) {
    return true;
  }
  const rel = relative(parent, child);
  // `relative` answers '..' or an absolute path for anything outside; both are
  // checked because a different drive/root yields the absolute form.
  return (
    rel.length > 0 &&
    !rel.startsWith(`..${sep}`) &&
    rel !== '..' &&
    !isAbsolute(rel)
  );
}

/**
 * The real path of the deepest part of `p` that exists, with whatever does not
 * exist yet appended lexically.
 *
 * Plain `realpath` is not enough, and the reason is not hypothetical: a new
 * file in a new sub-directory has no parent to resolve, so falling back to the
 * lexical path there compared an UNRESOLVED path against a RESOLVED cwd — and
 * on macOS a temp dir is `/var/…`, a symlink to `/private/var/…`, so the two
 * never matched and every file creation was refused as escaping.
 *
 * Resolving the existing prefix keeps both halves honest: a symlinked directory
 * in the chain is still followed and still caught, and the parts that do not
 * exist cannot be redirected by anything, because there is nothing there yet.
 */
async function realNearest(p: string): Promise<string> {
  let current = p;
  let tail = '';
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Walked to the root without finding anything readable.
        return p;
      }
      tail =
        tail.length === 0 ? basename(current) : join(basename(current), tail);
      current = parent;
    }
  }
}

/** A filesystem error's `code`, which is safe to hand to a model. */
function codeOf(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : 'unknown error';
}
