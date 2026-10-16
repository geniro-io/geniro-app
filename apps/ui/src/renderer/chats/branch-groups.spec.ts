import { describe, expect, it } from 'vitest';

import { branchGroups } from './branch-groups';

const asRow = (branch: string) => ({ value: branch, label: branch });

describe('branchGroups', () => {
  it('lifts the long-lived branches to the top, under their own label', () => {
    const groups = branchGroups(
      ['feat/a', 'dev', 'fix/b', 'main', 'staging'],
      asRow,
    );

    expect(groups.map((group) => group.label)).toEqual([
      'Main branches',
      'Branches',
    ]);
    // Trunk first, then integration, then deploy lines — not git's order.
    expect(groups[0]!.items.map((item) => item.value)).toEqual([
      'main',
      'dev',
      'staging',
    ]);
    // Everything else keeps the order git listed it in.
    expect(groups[1]!.items.map((item) => item.value)).toEqual([
      'feat/a',
      'fix/b',
    ]);
  });

  it('draws one unlabelled group when there is only one kind of branch', () => {
    expect(branchGroups(['feat/a', 'fix/b'], asRow)).toEqual([
      { items: [asRow('feat/a'), asRow('fix/b')] },
    ]);
    expect(branchGroups(['master', 'main'], asRow)).toEqual([
      { items: [asRow('main'), asRow('master')] },
    ]);
  });

  it('matches whole names only — a feature branch named after main stays below', () => {
    const groups = branchGroups(['main', 'main-old', 'feature/dev'], asRow);

    expect(groups[0]!.items.map((item) => item.value)).toEqual(['main']);
    expect(groups[1]!.items.map((item) => item.value)).toEqual([
      'main-old',
      'feature/dev',
    ]);
  });
});
