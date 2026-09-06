import type { GitChange } from '../../shared/contracts';

/** One changed file, at the leaf of its directory. */
export interface ChangeTreeFile {
  type: 'file';
  /** The last path segment — the directories above it carry the rest. */
  name: string;
  change: GitChange;
}

/** A directory, with whatever changed underneath it rolled up. */
export interface ChangeTreeDir {
  type: 'dir';
  /**
   * The segments this node stands for, joined — `v1/agents/services`, not
   * `services`, when the chain above it held nothing else.
   */
  name: string;
  /** The full path from the repository root, which is what keys the fold. */
  path: string;
  children: ChangeTreeNode[];
  /** Files under this node, at any depth. */
  files: number;
  /**
   * Lines added and removed under this node.
   *
   * Null only when NOTHING beneath it was measured — one unmeasured file among
   * ten does not make the directory's total unknown, it makes it a total over
   * the nine that were counted, which is the more useful of the two answers and
   * the one the file rows themselves already imply.
   */
  added: number | null;
  removed: number | null;
}

export type ChangeTreeNode = ChangeTreeDir | ChangeTreeFile;

interface Building {
  dirs: Map<string, Building>;
  files: ChangeTreeFile[];
}

const empty = (): Building => ({ dirs: new Map(), files: [] });

/**
 * A flat list of changed paths as the directory tree they describe.
 *
 * The flat list was what shipped, and on a monorepo it is mostly repetition: 67
 * rows sharing `apps/daemon/src/v1/agents/` spend their width restating a prefix
 * the reader has already read, and the filename — the only part that identifies
 * the row — is pushed to the far end of each line where the eye has to hunt for
 * it. A tree states each prefix once and puts the names in a column.
 *
 * **Single-child directory chains are COLLAPSED** (`apps` → `apps/daemon/src`
 * when nothing else lives under either), which is what keeps a tree from being
 * worse than the list it replaced: uncollapsed, a Java-shaped or a monorepo path
 * spends five nearly-empty rows and five levels of indent to say what one row
 * says. Collapsing only ever runs where there was no branch, so nothing that
 * differs is hidden.
 *
 * The order is directories first, then files, each alphabetical — the
 * conventional file-tree shape, and stable, which matters because the caller
 * re-reads on every open and rows carry their own expanded state.
 */
export function buildChangesTree(
  changes: readonly GitChange[],
): ChangeTreeNode[] {
  const root = empty();
  for (const change of changes) {
    const segments = change.path.split('/').filter((part) => part !== '');
    const name = segments.pop();
    if (name === undefined) {
      continue;
    }
    let node = root;
    for (const segment of segments) {
      let next = node.dirs.get(segment);
      if (!next) {
        next = empty();
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.push({ type: 'file', name, change });
  }
  return finish(root, '');
}

function finish(node: Building, prefix: string): ChangeTreeNode[] {
  const dirs: ChangeTreeDir[] = [];
  for (const [segment, child] of node.dirs) {
    dirs.push(
      collapse(
        child,
        segment,
        prefix === '' ? segment : `${prefix}/${segment}`,
      ),
    );
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

/**
 * Build one directory, absorbing a single-child directory chain into its name.
 *
 * The loop walks DOWN while the node holds exactly one directory and no files
 * of its own — a file beside the directory is a branch, so `src/main.ts` next to
 * `src/v1/` stops the absorption at `src` where it should.
 */
function collapse(node: Building, name: string, path: string): ChangeTreeDir {
  let current = node;
  let joined = name;
  let full = path;
  for (;;) {
    if (current.files.length > 0 || current.dirs.size !== 1) {
      break;
    }
    const [segment, only] = [...current.dirs][0]!;
    joined = `${joined}/${segment}`;
    full = `${full}/${segment}`;
    current = only;
  }
  const children = finish(current, full);
  return {
    type: 'dir',
    name: joined,
    path: full,
    children,
    ...rollUp(children),
  };
}

/** Sum what is under a node — see {@link ChangeTreeDir.added} on the nulls. */
function rollUp(children: readonly ChangeTreeNode[]): {
  files: number;
  added: number | null;
  removed: number | null;
} {
  let files = 0;
  let added: number | null = null;
  let removed: number | null = null;
  for (const child of children) {
    if (child.type === 'file') {
      files += 1;
      if (child.change.added !== null) {
        added = (added ?? 0) + child.change.added;
      }
      if (child.change.removed !== null) {
        removed = (removed ?? 0) + child.change.removed;
      }
      continue;
    }
    files += child.files;
    if (child.added !== null) {
      added = (added ?? 0) + child.added;
    }
    if (child.removed !== null) {
      removed = (removed ?? 0) + child.removed;
    }
  }
  return { files, added, removed };
}
