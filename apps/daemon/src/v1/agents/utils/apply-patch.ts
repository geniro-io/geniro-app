import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
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
 * THREE times — once lexically on the resolved path, once on the real path of
 * the containing directory, and once on the file ITSELF — because a lexical
 * check alone is satisfied by a symlink that sits inside the folder and points
 * anywhere at all, and the directory check alone by a link that IS the file
 * (`notes.md -> ../outside/target.txt`, measured writing outside in both
 * shapes). The file is then opened with `O_NOFOLLOW`, so a link swapped in
 * after the check fails the open instead of redirecting the write.
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
  // The real path of the PARENT first: the file may legitimately not exist
  // yet, and it is the directory chain that a symlink would redirect.
  const parent = dirname(target);
  const realCwd = await realNearest(cwd);
  if (!isInside(realCwd, await realNearest(parent))) {
    return { status: 'stale', reason: LINK_OUT };
  }
  // Then the LAST component, which the parent check cannot see. `stale`
  // rather than `unavailable`, on that arm's own terms: the user said yes and
  // this is a path the app will not write to, so the agent's right move is to
  // look at the path again — not to read the refusal as a missing capability.
  const resolved = await writableTarget(realCwd, target);
  if (!resolved.ok) {
    return { status: 'stale', reason: resolved.reason };
  }

  if (patch.oldString === undefined) {
    // No search text: this is `Write`'s shape — a new file, or a deliberate
    // whole-file replacement. The user saw the entire body as additions.
    try {
      await mkdir(parent, { recursive: true });
      await writeNoFollow(resolved.path, patch.newString);
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
    current = await readNoFollow(resolved.path);
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
    await writeNoFollow(resolved.path, next);
  } catch (err) {
    return {
      status: 'stale',
      reason: `the file could not be written (${codeOf(err)})`,
    };
  }
  return { status: 'applied', path: relative(cwd, target) || patch.filePath };
}

const LINK_OUT = 'the path resolves outside this chat’s folder through a link';

/**
 * Where a write to `target` would actually land, or why it must not happen.
 *
 * A link AT the target is followed only when its real path is inside the
 * folder — `CLAUDE.md -> AGENTS.md` is an ordinary repository layout, and the
 * user saw a diff of that file's contents — and the write then goes to that
 * real path, never through the link. A DANGLING link is refused outright: a
 * write through it creates its target, which is planting a file wherever the
 * link names, and there is no real path to check that against.
 *
 * Anything but a regular file is refused before it is opened: a FIFO inside
 * the folder would hang the read waiting for a writer, so the patch would
 * never answer at all.
 */
async function writableTarget(
  realCwd: string,
  target: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  let found;
  try {
    found = await lstat(target);
  } catch (err) {
    // Nothing there is the ordinary case for a new file, and it is `open`'s to
    // report for an edit — with the sentence the edit path already says.
    return codeOf(err) === 'ENOENT'
      ? { ok: true, path: target }
      : { ok: false, reason: `the path could not be checked (${codeOf(err)})` };
  }
  let path = target;
  if (found.isSymbolicLink()) {
    try {
      path = await realpath(target);
      found = await lstat(path);
    } catch {
      return { ok: false, reason: 'the path is a link to nothing' };
    }
    if (!isInside(realCwd, path)) {
      return { ok: false, reason: LINK_OUT };
    }
  }
  if (!found.isFile()) {
    return { ok: false, reason: 'the path is not a regular file' };
  }
  return { ok: true, path };
}

/**
 * Open flags shared by both halves. `O_NOFOLLOW` closes the window between
 * {@link writableTarget}'s check and the open: a link planted there fails the
 * open (`ELOOP`) rather than redirecting the write. `O_NONBLOCK` does the same
 * for a FIFO swapped in, which would otherwise block the open itself; on a
 * regular file it changes nothing.
 */
const NO_FOLLOW = constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function readNoFollow(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function writeNoFollow(path: string, text: string): Promise<void> {
  // 0o666 before the umask — what `writeFile` creates a new file with.
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW,
    0o666,
  );
  try {
    await handle.writeFile(text, 'utf8');
  } finally {
    await handle.close();
  }
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
