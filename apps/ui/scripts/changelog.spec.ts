import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkChangelog,
  foldChangelog,
  loadChangelog,
  resolveFragmentReleases,
} from './changelog';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

const CHANGELOG = `# Changelog

Released history.

## 1.0.0 — 2026-01-01

### Fixed

- First fix
`;

let root: string;

function run(...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

function commit(message: string, date: string): void {
  run('add', '-A');
  execFileSync(
    'git',
    ['-C', root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message],
    {
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
        GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
      },
    },
  );
}

function writeFragment(name: string, body: string): void {
  mkdirSync(join(root, 'changelog', 'unreleased'), { recursive: true });
  writeFileSync(join(root, 'changelog', 'unreleased', name), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'geniro-changelog-'));
  run('init', '-q');
  run('config', 'user.email', 'test@example.test');
  run('config', 'user.name', 'Test');
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG);
  commit('chore: start', '2026-01-01');
  run('tag', 'v1.0.0');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveFragmentReleases', () => {
  it('files a fragment under the lowest release tag containing the commit that added it', () => {
    writeFragment('search.md', '### New\n\n- Search the changelog\n');
    commit('feat: search', '2026-02-03');
    run('tag', 'v1.2.0-rc1');
    run('tag', 'v1.2.0');
    run('tag', 'v1.10.0');

    const resolved = resolveFragmentReleases(root, [
      'changelog/unreleased/search.md',
    ]);

    expect(resolved.get('changelog/unreleased/search.md')).toEqual({
      version: '1.2.0',
      date: '2026-02-03',
    });
  });

  it('leaves a committed but untagged fragment, and an uncommitted one, unreleased', () => {
    writeFragment('tagged-later.md', '### Fixed\n\n- Later\n');
    commit('fix: later', '2026-02-04');
    writeFragment('local.md', '### Fixed\n\n- Local\n');

    const resolved = resolveFragmentReleases(root, [
      'changelog/unreleased/tagged-later.md',
      'changelog/unreleased/local.md',
    ]);

    expect(resolved.get('changelog/unreleased/tagged-later.md')).toBeNull();
    expect(resolved.get('changelog/unreleased/local.md')).toBeNull();
  });

  it('ignores a pre-release tag, so a fragment only an rc carries stays unreleased', () => {
    writeFragment('rc-only.md', '### New\n\n- On the rc\n');
    commit('feat: rc', '2026-02-05');
    run('tag', 'v1.3.0-rc1');

    const resolved = resolveFragmentReleases(root, [
      'changelog/unreleased/rc-only.md',
    ]);

    expect(resolved.get('changelog/unreleased/rc-only.md')).toBeNull();
  });

  it('files a fragment name reused after a fold by the commit that added it last', () => {
    writeFragment('reused.md', '### Fixed\n\n- Old note\n');
    commit('fix: old', '2026-02-06');
    run('tag', 'v1.1.0');
    rmSync(join(root, 'changelog', 'unreleased', 'reused.md'));
    commit('docs(changelog): fold', '2026-02-07');
    writeFragment('reused.md', '### Fixed\n\n- New note\n');
    commit('fix: new', '2026-02-08');

    const resolved = resolveFragmentReleases(root, [
      'changelog/unreleased/reused.md',
    ]);

    expect(resolved.get('changelog/unreleased/reused.md')).toBeNull();
  });

  it('answers unreleased instead of throwing outside a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'geniro-changelog-plain-'));
    try {
      const resolved = resolveFragmentReleases(plain, [
        'changelog/unreleased/x.md',
      ]);
      expect(resolved.get('changelog/unreleased/x.md')).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('loadChangelog', () => {
  it('merges released fragments into their version and groups the rest as unreleased', () => {
    writeFragment('a.md', '### Fixed\n\n- Second fix\n');
    commit('fix: second', '2026-03-01');
    run('tag', 'v1.0.1');
    writeFragment('b.md', '### New\n\n- Not shipped yet\n');

    expect(loadChangelog(root)).toEqual([
      {
        version: null,
        date: null,
        sections: [{ kind: 'new', entries: ['Not shipped yet'] }],
      },
      {
        version: '1.0.1',
        date: '2026-03-01',
        sections: [{ kind: 'fixed', entries: ['Second fix'] }],
      },
      {
        version: '1.0.0',
        date: '2026-01-01',
        sections: [{ kind: 'fixed', entries: ['First fix'] }],
      },
    ]);
  });
});

describe('foldChangelog', () => {
  it('moves released fragments into CHANGELOG.md, deletes them and keeps unreleased ones', () => {
    writeFragment('shipped.md', '### New\n\n- Shipped feature\n');
    writeFragment('faster-start.md', '### Improved\n\n- Faster start\n');
    commit('feat: shipped', '2026-04-01');
    run('tag', 'v1.1.0');
    writeFragment('pending.md', '### Fixed\n\n- Pending fix\n');

    const folded = foldChangelog(root);

    expect(folded.sort()).toEqual([
      'changelog/unreleased/faster-start.md',
      'changelog/unreleased/shipped.md',
    ]);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(
      `# Changelog

Released history.

## 1.1.0 — 2026-04-01

### New

- Shipped feature

### Improved

- Faster start

## 1.0.0 — 2026-01-01

### Fixed

- First fix
`,
    );
    expect(existsSync(join(root, 'changelog/unreleased/shipped.md'))).toBe(
      false,
    );
    expect(existsSync(join(root, 'changelog/unreleased/pending.md'))).toBe(
      true,
    );
  });

  it('changes nothing when run again', () => {
    writeFragment('shipped.md', '### New\n\n- Shipped feature\n');
    commit('feat: shipped', '2026-04-01');
    run('tag', 'v1.1.0');
    foldChangelog(root);
    const once = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

    expect(foldChangelog(root)).toEqual([]);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(once);
  });
});

describe('the repository changelog', () => {
  it('parses CHANGELOG.md and every unreleased fragment', () => {
    const { releases } = checkChangelog(REPO_ROOT);

    expect(releases).toBeGreaterThan(0);
  });
});
