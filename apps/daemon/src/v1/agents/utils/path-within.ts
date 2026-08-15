import { sep } from 'node:path';

/**
 * Is `path` the directory `root`, or somewhere inside it?
 *
 * A SEGMENT-wise containment test, not a string prefix: `startsWith(root)`
 * alone says `/work/app-old` is inside `/work/app`, which would file a run into
 * a group that never claimed its folder. Appending the separator first is what
 * makes the boundary a real one.
 *
 * Both arguments are expected CANONICAL (the form `resolveValidDirectory`
 * returns) — symlinks resolved, no trailing separator, no `..`. This helper
 * deliberately does not canonicalize: it is a pure comparison, and touching the
 * filesystem here would make an ordinary list read do IO per group.
 */
export function isWithinDirectory(path: string, root: string): boolean {
  if (path === root) {
    return true;
  }
  // A root that already ends in the separator is the filesystem root itself
  // (`/`), where appending a second one would ask about `//…` and match
  // nothing.
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(prefix);
}
