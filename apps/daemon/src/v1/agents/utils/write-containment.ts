import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { isWithinDirectory } from './path-within';

/**
 * Where a write to `target` would land relative to `root`: `inside` it,
 * `outside` it by its path alone, or outside it only once links are followed
 * (`through-link`). A path relative to `root` is read against it.
 *
 * The ONE answer for every write geniro lets through without the user looking —
 * a patch the user accepted (`applyHostPatch`) and a codex file change
 * `acceptEdits` takes unasked — so a hardening lands in both at once.
 *
 * A path is followed the way the kernel follows it ({@link landing}), and it is
 * followed TWICE, because a writer may take either of two readings of one
 * string: AS WRITTEN, where a `..` after a link steps out of the link's target,
 * and RESOLVED first, where `..` is collapsed before the kernel sees the path —
 * what `path.resolve` does, and what codex's own patch applier was measured to
 * do. `inside` only when both land inside. A caller that knows its writer
 * resolves first passes the resolved path, which makes the two one reading
 * (`applyHostPatch`); a CLI's writer is not ours to know, so its raw path must
 * pass both.
 */
export function writeContainment(
  root: string,
  target: string,
): 'inside' | 'outside' | 'through-link' {
  const base = resolve(root);
  const lexical = resolve(base, target);
  if (!isWithinDirectory(lexical, base)) {
    return 'outside';
  }
  const home = landing(base);
  const asWritten = landing(
    isAbsolute(target) ? target : `${base}${sep}${target}`,
  );
  const asResolved = landing(lexical);
  return home !== null &&
    asWritten !== null &&
    asResolved !== null &&
    isWithinDirectory(asWritten, home) &&
    isWithinDirectory(asResolved, home)
    ? 'inside'
    : 'through-link';
}

/**
 * Where the kernel would put a write to `path`, following it one component at
 * a time exactly as given: a link is replaced by its real target when it is
 * reached, so a `..` after it steps out of that TARGET, and whatever does not
 * exist yet is appended as written — nothing that is not there can redirect.
 * `null` when a link on the way leads nowhere: a write through a dangling link
 * creates whatever it points at, and a loop has no answer.
 *
 * Component by component rather than one `realpath` of the whole, which cannot
 * answer for a file that does not exist yet: its existing prefix comes back
 * real here — a temp dir under `/var`, itself a link to `/private/var`, still
 * compares equal to its resolved root — with the new part appended to it.
 *
 * Synchronous because one caller decides inside a synchronous protocol handler
 * (codex's file-change auto-accept); the walk is an `lstat` per component.
 */
function landing(path: string): string | null {
  let current: string = sep;
  for (const part of path.split(sep)) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch {
      current = next;
      continue;
    }
    if (!isLink) {
      current = next;
      continue;
    }
    try {
      current = realpathSync(next);
    } catch {
      return null;
    }
  }
  return current;
}
