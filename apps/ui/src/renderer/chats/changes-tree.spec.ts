import { describe, expect, it } from 'vitest';

import type { GitChange } from '../../shared/contracts';
import {
  buildChangesTree,
  type ChangeTreeNode,
  summarizeChanges,
} from './changes-tree';

const change = (
  path: string,
  added: number | null = 1,
  removed: number | null = 0,
): GitChange => ({
  path,
  status: 'modified',
  diff: null,
  added,
  removed,
});

/** `dir/` for a directory, its bare name for a file — the shape at a glance. */
const shape = (nodes: readonly ChangeTreeNode[]): unknown =>
  nodes.map((node) =>
    node.type === 'dir'
      ? { [`${node.name}/`]: shape(node.children) }
      : node.name,
  );

const dirAt = (
  nodes: readonly ChangeTreeNode[],
  name: string,
): Extract<ChangeTreeNode, { type: 'dir' }> => {
  const found = nodes.find((node) => node.type === 'dir' && node.name === name);
  if (found === undefined || found.type !== 'dir') {
    throw new Error(`no directory ${name} in ${JSON.stringify(shape(nodes))}`);
  }
  return found;
};

describe('buildChangesTree', () => {
  it('collapses a chain of directories that never branches', () => {
    // The whole reason the tree beats the flat list on a monorepo. Uncollapsed
    // this is five nearly-empty rows and five levels of indent to say what one
    // row says, which would be WORSE than the paths it replaced.
    expect(
      shape(buildChangesTree([change('apps/daemon/src/v1/main.ts')])),
    ).toEqual([{ 'apps/daemon/src/v1/': ['main.ts'] }]);
  });

  it('stops collapsing where the tree actually branches', () => {
    const tree = buildChangesTree([
      change('apps/daemon/src/main.ts'),
      change('apps/ui/src/index.ts'),
    ]);
    expect(shape(tree)).toEqual([
      {
        'apps/': [{ 'daemon/src/': ['main.ts'] }, { 'ui/src/': ['index.ts'] }],
      },
    ]);
  });

  it('stops collapsing at a directory that also holds a FILE', () => {
    // The subtle half: `src` has one sub-directory, so a chain-walk that only
    // counted directories would absorb `v1` and hide that `main.ts` lives at
    // `src`, filing it under `src/v1` — a path that is simply wrong.
    const tree = buildChangesTree([
      change('src/main.ts'),
      change('src/v1/agents/run.ts'),
    ]);
    expect(shape(tree)).toEqual([
      { 'src/': [{ 'v1/agents/': ['run.ts'] }, 'main.ts'] },
    ]);
  });

  it('keeps each node’s full path, not just the segments it absorbed', () => {
    const tree = buildChangesTree([change('apps/daemon/src/main.ts')]);
    expect(dirAt(tree, 'apps/daemon/src').path).toBe('apps/daemon/src');
  });

  it('rolls the line counts up through every level', () => {
    const tree = buildChangesTree([
      change('apps/a/one.ts', 10, 2),
      change('apps/b/two.ts', 5, 3),
    ]);
    const apps = dirAt(tree, 'apps');
    expect({
      added: apps.added,
      removed: apps.removed,
      files: apps.files,
    }).toEqual({ added: 15, removed: 5, files: 2 });
  });

  it('totals what WAS measured rather than giving up on one unmeasured file', () => {
    // A binary file or one past the untracked-body budget reports null. Letting
    // that null poison the directory would hide the nine counts beside it — and
    // the file rows themselves already show which one was not measured.
    const tree = buildChangesTree([
      change('apps/counted.ts', 7, 1),
      change('apps/binary.png', null, null),
    ]);
    const apps = dirAt(tree, 'apps');
    expect({
      added: apps.added,
      removed: apps.removed,
      files: apps.files,
    }).toEqual({ added: 7, removed: 1, files: 2 });
  });

  it('answers null only when NOTHING beneath it was measured', () => {
    const tree = buildChangesTree([change('apps/binary.png', null, null)]);
    const apps = dirAt(tree, 'apps');
    expect({ added: apps.added, removed: apps.removed }).toEqual({
      added: null,
      removed: null,
    });
  });

  it('puts directories before files, each alphabetical', () => {
    expect(
      shape(
        buildChangesTree([
          change('z.ts'),
          change('a.ts'),
          change('zeta/one.ts'),
          change('alpha/two.ts'),
        ]),
      ),
    ).toEqual([
      { 'alpha/': ['two.ts'] },
      { 'zeta/': ['one.ts'] },
      'a.ts',
      'z.ts',
    ]);
  });

  it('keeps a file at the repository root at the root', () => {
    expect(shape(buildChangesTree([change('README.md')]))).toEqual([
      'README.md',
    ]);
  });

  it('has nothing to draw for nothing changed', () => {
    expect(buildChangesTree([])).toEqual([]);
  });
});

describe('summarizeChanges', () => {
  it('agrees with the tree’s own roll-up, which is the point of it', () => {
    // The header chip states these figures and the tree states them again on
    // its root row, inches apart, about one read. Two arithmetics is how they
    // would come to disagree, so this pins that they do not.
    const changes = [
      change('apps/a/one.ts', 10, 2),
      change('apps/b/two.ts', 5, 3),
    ];
    const apps = dirAt(buildChangesTree(changes), 'apps');
    expect(summarizeChanges(changes)).toEqual({
      files: apps.files,
      added: apps.added,
      removed: apps.removed,
    });
  });

  it('counts a file at the repository ROOT, which no directory holds', () => {
    // The reason this is its own function rather than a roll-up over the tree's
    // roots: `README.md` belongs to no directory, so summing the directories
    // would silently leave it out of the total.
    expect(summarizeChanges([change('README.md', 4, 1)])).toEqual({
      files: 1,
      added: 4,
      removed: 1,
    });
  });

  it('totals what WAS measured, and answers null only when nothing was', () => {
    expect(
      summarizeChanges([change('a.ts', 7, 1), change('b.png', null, null)]),
    ).toEqual({ files: 2, added: 7, removed: 1 });
    expect(summarizeChanges([change('b.png', null, null)])).toEqual({
      files: 1,
      added: null,
      removed: null,
    });
  });

  it('reads an empty folder as zero, which is not the same as unmeasured', () => {
    expect(summarizeChanges([])).toEqual({
      files: 0,
      added: null,
      removed: null,
    });
  });
});
