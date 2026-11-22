import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initGitRepo,
  makeRepoDir,
  removeRepoDir,
  runGit,
} from './__tests__/git-changes-repo';
import { countDiffLines, readChangesTotals } from './git-changes';

vi.setConfig({ testTimeout: 30_000 });

let dir = '';

const run = (args: string[]): string => runGit(dir, args);
const initRepo = (): string => initGitRepo(dir);

beforeEach(() => {
  dir = makeRepoDir();
});

afterEach(() => {
  removeRepoDir(dir);
});

describe('countDiffLines', () => {
  it('counts a removed line that begins with two dashes, and an added one that begins with two pluses', () => {
    // A content line keeps its own prefix: a removed `-- drop me` reads `--- drop me`, and a
    // header-style prefix test skipped it.
    const body = [
      'diff --git a/q.sql b/q.sql',
      'index 1111111..2222222 100644',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,2 +1,2 @@',
      '--- drop me',
      '+++counter;',
      ' keep',
    ].join('\n');

    expect(countDiffLines(body)).toEqual({ added: 1, removed: 1 });
  });

  it('counts a mode change, which has no hunk, as zero lines rather than as unmeasured', () => {
    const body = [
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');

    expect(countDiffLines(body)).toEqual({ added: 0, removed: 0 });
  });

  it('answers null for a binary change, which has no lines to count', () => {
    expect(
      countDiffLines('Binary files a/logo.png and b/logo.png differ'),
    ).toEqual({ added: null, removed: null });
  });

  it('answers null for a binary patch, which carries no hunk either', () => {
    const body = [
      'diff --git a/logo.png b/logo.png',
      'index 1234567..89abcde 100644',
      'GIT binary patch',
      'literal 12',
      'zcmZQzU|?ckU|?ckU|?ck',
    ].join('\n');

    expect(countDiffLines(body)).toEqual({ added: null, removed: null });
  });

  it('answers null for a body that was never read', () => {
    expect(countDiffLines(null)).toEqual({ added: null, removed: null });
  });
});

describe('readChangesTotals', () => {
  it('adds up the lines every changed file added and removed, tracked and untracked alike', async () => {
    initRepo();
    writeFileSync(join(dir, 'lib.txt'), 'a\nb\nc\nd\ne\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'add lib']);
    const sha = run(['rev-parse', 'HEAD']);
    // Each file moves the counts differently, so a sum that dropped a file or a
    // whole side lands on another pair of numbers.
    writeFileSync(join(dir, 'README.md'), 'one\ntwo\nthree\n'); // +3 −1
    writeFileSync(join(dir, 'lib.txt'), 'a\ne\n'); // +0 −3
    writeFileSync(join(dir, 'fresh.txt'), 'n1\nn2\n'); // never added: +2 −0

    expect(await readChangesTotals(dir, sha)).toEqual({
      linesAdded: 5,
      linesRemoved: 4,
      partial: false,
    });
  });

  it('leaves a file whose lines were not counted out of the sums, and marks the total partial', async () => {
    // A binary file has no hunk to count, so its counts are null. The total has
    // to say it is missing that file rather than read as complete.
    const sha = initRepo();
    writeFileSync(join(dir, 'README.md'), 'first\nsecond\nthird\n');
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    run(['add', '-A']);

    expect(await readChangesTotals(dir, sha)).toEqual({
      linesAdded: 3,
      linesRemoved: 1,
      partial: true,
    });
  });

  it('counts every changed file, however many there are', async () => {
    // The changes panel stops listing at 500 files; a total has no reader to protect and
    // counts them all.
    initRepo();
    const name = (index: number): string =>
      `f${String(index).padStart(4, '0')}.txt`;
    for (let i = 0; i < 520; i += 1) {
      writeFileSync(join(dir, name(i)), 'before\n');
    }
    run(['add', '.']);
    run(['commit', '-q', '-m', 'many files']);
    const sha = run(['rev-parse', 'HEAD']);
    for (let i = 0; i < 520; i += 1) {
      writeFileSync(join(dir, name(i)), 'after\n');
    }

    expect(await readChangesTotals(dir, sha)).toEqual({
      linesAdded: 520,
      linesRemoved: 520,
      partial: false,
    });
  });

  it('counts a tracked change too large for one diff to be read whole', async () => {
    // 9MB of changed lines: past the buffer a full diff is read into, which nulled every
    // tracked count. A numstat reads no bodies.
    const sha = initRepo();
    const line = 'x'.repeat(89) + '\n';
    writeFileSync(join(dir, 'big.txt'), line.repeat(100_000));
    // Tracked, which is the half this pins; an untracked file this size is past the
    // untracked read's own cap.
    run(['add', 'big.txt']);

    expect(await readChangesTotals(dir, sha)).toEqual({
      linesAdded: 100_000,
      linesRemoved: 0,
      partial: false,
    });
  });

  it('counts every untracked file, past the few whose diffs the changes panel reads', async () => {
    const sha = initRepo();
    for (let i = 0; i < 30; i += 1) {
      writeFileSync(join(dir, `new-${i}.txt`), 'one\ntwo\n');
    }

    expect(await readChangesTotals(dir, sha)).toEqual({
      linesAdded: 60,
      linesRemoved: 0,
      partial: false,
    });
  });

  it('counts an untracked file’s last line when it has no newline, and a symlink as one line', async () => {
    const sha = initRepo();
    writeFileSync(join(dir, 'tail.txt'), 'a\nb\nc');
    symlinkSync('tail.txt', join(dir, 'link.txt'));

    expect(await readChangesTotals(dir, sha)).toEqual({
      linesAdded: 4,
      linesRemoved: 0,
      partial: false,
    });
  });

  it('leaves an untracked binary file out of the sums, and marks the total partial', async () => {
    const sha = initRepo();
    writeFileSync(join(dir, 'note.txt'), 'one\n');
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([7, 0, 1]));

    expect(await readChangesTotals(dir, sha)).toEqual({
      linesAdded: 1,
      linesRemoved: 0,
      partial: true,
    });
  });

  it('says the base is unreachable, not zeros, when its commit is gone', async () => {
    // A rewritten history is where zeros would do the most harm: the tree may
    // have changed entirely, and nothing is left to measure it against.
    initRepo();

    expect(await readChangesTotals(dir, 'b'.repeat(40))).toEqual({
      baseUnreachable: true,
    });
  });

  it('answers null for a plain folder', async () => {
    expect(await readChangesTotals(dir, 'c'.repeat(40))).toBeNull();
  });

  it('answers zeros, not null, for a tree nothing has changed in', async () => {
    const sha = initRepo();

    expect(await readChangesTotals(dir, sha)).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
      partial: false,
    });
  });

  it('says the base is unreachable, not a total against HEAD, once the checkout has left it', async () => {
    // What is uncommitted NOW is a different measurement from the thread's own change.
    // The total back on the start branch would count the return as new growth, so
    // nothing is measured until the checkout descends from the start commit again.
    initRepo();
    run(['checkout', '-q', '-b', 'side']);
    writeFileSync(join(dir, 'side-only.txt'), 'on the side branch\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'side work']);
    const started = run(['rev-parse', 'HEAD']);
    run(['checkout', '-q', 'main']);
    writeFileSync(join(dir, 'README.md'), 'edited after the move\n');

    expect(await readChangesTotals(dir, started)).toEqual({
      baseUnreachable: true,
    });
  });

  it('reads no more untracked files than its cap, and marks the total partial', async () => {
    const sha = initRepo();
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      writeFileSync(join(dir, name), 'one\n');
    }

    expect(
      await readChangesTotals(dir, sha, {
        maxUntrackedFiles: 2,
        maxUntrackedFileBytes: 1024,
        untrackedBudgetMs: 20_000,
      }),
    ).toEqual({ linesAdded: 2, linesRemoved: 0, partial: true });
  });

  it('leaves an untracked file past the size cap uncounted, and marks the total partial', async () => {
    // A multi-megabyte log is read after every turn otherwise.
    const sha = initRepo();
    writeFileSync(join(dir, 'small.txt'), 'one\ntwo\n');
    writeFileSync(join(dir, 'huge.log'), 'line\n'.repeat(100));

    expect(
      await readChangesTotals(dir, sha, {
        maxUntrackedFiles: 10,
        maxUntrackedFileBytes: 100,
        untrackedBudgetMs: 20_000,
      }),
    ).toEqual({ linesAdded: 2, linesRemoved: 0, partial: true });
  });

  it('leaves untracked files reached past the read budget uncounted, and marks the total partial', async () => {
    const sha = initRepo();
    writeFileSync(join(dir, 'README.md'), 'changed\n');
    writeFileSync(join(dir, 'late.txt'), 'one\n');

    expect(
      await readChangesTotals(dir, sha, {
        maxUntrackedFiles: 10,
        maxUntrackedFileBytes: 1024,
        untrackedBudgetMs: -1,
      }),
    ).toEqual({ linesAdded: 1, linesRemoved: 1, partial: true });
  });

  it('stops reading an untracked file once the budget runs out mid-read, and marks the total partial', async () => {
    // The clock passes the deadline after the read has started, so only the check made
    // between chunks can stop it; the one made before each file has already passed.
    const sha = initRepo();
    writeFileSync(join(dir, 'long.txt'), 'line\n'.repeat(100_000));
    let calls = 0;
    const now = (): number => (calls++ < 2 ? 0 : 1_000_000);

    expect(
      await readChangesTotals(dir, sha, {
        maxUntrackedFiles: 10,
        maxUntrackedFileBytes: 4 * 1024 * 1024,
        untrackedBudgetMs: 100,
        now,
      }),
    ).toBeNull();
  });

  it('counts a file still being written only up to the size it had when it was opened', async () => {
    // A log a background command appends to must not be chased as it grows. The clock is
    // read once per chunk, which is where this test appends to the file mid-read.
    const sha = initRepo();
    const path = join(dir, 'growing.log');
    writeFileSync(path, 'line\n'.repeat(50_000));
    let calls = 0;
    const now = (): number => {
      calls += 1;
      if (calls === 3) {
        appendFileSync(path, 'more\n'.repeat(10_000));
      }
      return 0;
    };

    expect(
      await readChangesTotals(dir, sha, {
        maxUntrackedFiles: 10,
        maxUntrackedFileBytes: 4 * 1024 * 1024,
        untrackedBudgetMs: 100,
        now,
      }),
    ).toEqual({ linesAdded: 50_000, linesRemoved: 0, partial: false });
  });

  it('reads the files of a repository whose path holds a newline', async () => {
    // git prints the top level unquoted, so a parser splitting its output on every
    // newline read such a repository's untracked files from the wrong directory.
    const parent = dir;
    dir = join(parent, 'odd\nname');
    mkdirSync(dir);
    try {
      const sha = initRepo();
      writeFileSync(join(dir, 'new.txt'), 'one\ntwo\n');

      expect(await readChangesTotals(dir, sha)).toEqual({
        linesAdded: 2,
        linesRemoved: 0,
        partial: false,
      });
    } finally {
      dir = parent;
    }
  });

  it('counts an untracked file whose name git would quote', async () => {
    // A newline-separated listing quotes a name holding a tab, and the quoted name
    // named no file — the total came back partial for a file that was right there.
    const sha = initRepo();
    writeFileSync(join(dir, 'tab\there.txt'), 'one\ntwo\n');

    expect(await readChangesTotals(dir, sha)).toEqual({
      linesAdded: 2,
      linesRemoved: 0,
      partial: false,
    });
  });

  it.each([
    ['whether the base is an ancestor', 'merge-base'],
    ['whether the base commit exists', 'rev-parse --verify'],
  ])(
    'answers null, not unreachable, when git fails to answer %s',
    async (_question, failing) => {
      // "Unreachable" makes the caller replace the folder's baseline. A git failure is
      // no evidence the folder left it, so it must read as unmeasured.
      const sha = initRepo();
      const bin = mkdtempSync(join(tmpdir(), 'geniro-fake-git-'));
      const realGit = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      writeFileSync(
        join(bin, 'git'),
        `#!/bin/sh\ncase "$*" in *${failing}*) exit 128;; esac\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 },
      );
      const path = process.env.PATH;
      process.env.PATH = `${bin}:${path ?? ''}`;
      try {
        expect(await readChangesTotals(dir, sha)).toBeNull();
      } finally {
        process.env.PATH = path;
        rmSync(bin, { recursive: true, force: true });
      }
    },
  );

  it('answers null when every change is one that cannot be counted', async () => {
    // A binary file's lines cannot be counted. "+0 −0" would claim the thread changed
    // nothing, when its only change is one nothing could count.
    const sha = initRepo();
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    run(['add', '-A']);

    expect(await readChangesTotals(dir, sha)).toBeNull();
  });
});
