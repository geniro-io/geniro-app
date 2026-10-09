import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countDiffLines,
  readChangesSince,
  readChangesTotals,
} from './git-changes';

/**
 * Driven against REAL repositories, like `git-info.spec.ts` beside it and for
 * the same reason: the behaviour under test is git's own — which changes
 * `diff <sha>` reports, and which it silently leaves out — and a mocked
 * `execFile` would only replay this file's assumptions about that.
 */
vi.setConfig({ testTimeout: 30_000 });

let dir = '';

const run = (args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/** A repo on `main` with one commit, and that commit's sha. */
function initRepo(): string {
  execFileSync('git', ['init', '-b', 'main', '-q', dir], { cwd: tmpdir() });
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  return run(['rev-parse', 'HEAD']);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geniro-changes-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readChangesSince', () => {
  it('reports nothing changed on an untouched tree', async () => {
    const sha = initRepo();

    expect(await readChangesSince(dir, sha)).toEqual({
      changes: [],
      truncated: false,
      unavailableReason: null,
      movedOffStart: false,
      upstreamBase: null,
    });
  });

  it('lists a file that was created and never `git add`ed', async () => {
    // THE criterion this pairing exists for. `git diff <sha>` does not mention
    // an untracked file at all, so an agent that wrote one and did not stage it
    // would show as having changed nothing.
    const sha = initRepo();
    writeFileSync(join(dir, 'notes.md'), 'a new file\n');

    const { changes } = await readChangesSince(dir, sha);

    const notes = changes.find((change) => change.path === 'notes.md');
    expect(notes?.status).toBe('untracked');
    // With its contents, rendered read-only: `git add -N` would make it appear
    // in an ordinary diff and would write to the user's own index.
    expect(notes?.diff).toContain('a new file');
    // And the index really was left alone — the whole claim of a read-only view.
    expect(run(['status', '--porcelain'])).toContain('?? notes.md');
  });

  it('reports a modification with its diff body', async () => {
    const sha = initRepo();
    writeFileSync(join(dir, 'README.md'), 'hello again\n');

    const { changes } = await readChangesSince(dir, sha);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toBe('modified');
    expect(changes[0]!.diff).toContain('-hello');
    expect(changes[0]!.diff).toContain('+hello again');
  });

  it('reports a STAGED change too, not only an unstaged one', async () => {
    // `git diff <sha>` compares the working TREE against the commit, so both
    // sides of the index are covered — which is what a reader wants from "since
    // this chat started" and what a bare `git diff` would have missed.
    const sha = initRepo();
    writeFileSync(join(dir, 'staged.txt'), 'added and staged\n');
    run(['add', 'staged.txt']);

    const { changes } = await readChangesSince(dir, sha);

    const staged = changes.find((change) => change.path === 'staged.txt');
    expect(staged?.status).toBe('added');
  });

  it('reports a deletion', async () => {
    const sha = initRepo();
    unlinkSync(join(dir, 'README.md'));

    const { changes } = await readChangesSince(dir, sha);

    expect(changes[0]!.status).toBe('deleted');
  });

  it('keeps each file’s diff to its own row', async () => {
    // One `git diff` is taken and split here rather than asked for per file — a
    // branch's worth of work is hundreds of files, and that many subprocesses is
    // the difference between a view that opens and one that hangs. The split has
    // to attribute each body to the right path.
    const sha = initRepo();
    writeFileSync(join(dir, 'README.md'), 'first change\n');
    writeFileSync(join(dir, 'second.txt'), 'second change\n');
    run(['add', 'second.txt']);

    const { changes } = await readChangesSince(dir, sha);

    const readme = changes.find((change) => change.path === 'README.md');
    const second = changes.find((change) => change.path === 'second.txt');
    expect(readme?.diff).toContain('first change');
    expect(readme?.diff).not.toContain('second change');
    expect(second?.diff).toContain('second change');
    expect(second?.diff).not.toContain('first change');
  });

  it('speaks ONE path language when the run folder is a subdirectory', async () => {
    // A chat is routinely opened in `apps/ui` of a monorepo. By default the two
    // halves disagree: `diff` reports repo-root-relative paths for the whole
    // repository while `ls-files` reports cwd-relative ones for the cwd's
    // subtree alone — so one list carried two meanings, identical basenames
    // collided on the row key, and a new file written elsewhere in the repo was
    // dropped entirely, which is the loss pairing them exists to prevent.
    const sha = initRepo();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'tracked.txt'), 'first\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'add sub']);
    const afterSub = run(['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'sub', 'tracked.txt'), 'edited\n');
    writeFileSync(join(dir, 'sub', 'new-here.txt'), 'inside the run folder\n');
    writeFileSync(join(dir, 'new-above.txt'), 'elsewhere in the repo\n');

    const { changes } = await readChangesSince(join(dir, 'sub'), afterSub);
    const paths = changes.map((change) => change.path);

    // Repo-root-relative on BOTH halves — never a bare `new-here.txt`.
    expect(paths).toContain('sub/tracked.txt');
    expect(paths).toContain('sub/new-here.txt');
    // And the scope is the repository, so a new file above the run folder is
    // still reported rather than silently missing.
    expect(paths).toContain('new-above.txt');
    // The body of an untracked file is read from the repo root too, or the
    // repo-relative path would name nothing from inside `sub`.
    expect(
      changes.find((change) => change.path === 'sub/new-here.txt')?.diff,
    ).toContain('inside the run folder');
    expect(sha).not.toBe(afterSub);
  });

  it('produces a diff rather than running the repository’s own program', async () => {
    // `.git/config` travels with a repository — an archive, a clone, a folder an
    // agent was pointed at — and `diff.external` names a command git runs in
    // place of the diff. A read-only view of what changed must not execute it.
    //
    // This also pins the shape of the refusal. `-c diff.external=` does NOT
    // disable an external diff: it sets one to the empty command, and git dies
    // with `cannot run : No such file or directory` on every file — measured,
    // and the reason the flags are used instead.
    const sha = initRepo();
    run(['config', 'diff.external', '/bin/false']);
    writeFileSync(join(dir, 'README.md'), 'edited\n');

    const { changes, unavailableReason } = await readChangesSince(dir, sha);

    expect(unavailableReason).toBeNull();
    expect(changes[0]!.diff).toContain('+edited');
  });

  it('runs none of the repository’s own FILTER drivers — on a changed file or a new one', async () => {
    // `--no-textconv` refuses the diff driver and says nothing about a clean
    // filter, which git runs on every working-tree file it reads: the modified
    // file in the tree diff, and the untracked one in its `--no-index` body.
    // Both measured running one before the fix.
    const scratch = mkdtempSync(join(tmpdir(), 'geniro-changes-filter-'));
    try {
      const marker = join(scratch, 'filter-ran');
      const program = join(scratch, 'evil.sh');
      writeFileSync(
        program,
        `#!/bin/sh\n: > ${JSON.stringify(marker)}\ncat\n`,
        {
          mode: 0o755,
        },
      );
      initRepo();
      writeFileSync(join(dir, '.gitattributes'), '*.txt filter=evil\n');
      writeFileSync(join(dir, 'tracked.txt'), 'before\n');
      run(['add', '.']);
      run(['commit', '-q', '-m', 'filtered files']);
      const sha = run(['rev-parse', 'HEAD']);
      run(['config', 'filter.evil.clean', program]);
      writeFileSync(join(dir, 'tracked.txt'), 'after\n');
      writeFileSync(join(dir, 'untracked.txt'), 'brand new\n');
      // The control: plain git runs it on exactly this tree.
      run(['diff', '--no-ext-diff', '--no-textconv', sha]);
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      const { changes, unavailableReason } = await readChangesSince(dir, sha);

      expect(existsSync(marker)).toBe(false);
      expect(unavailableReason).toBeNull();
      // Still the diff the user expects — the raw bytes, since the filter here
      // passes them through unchanged.
      expect(
        changes.find((change) => change.path === 'tracked.txt')?.diff,
      ).toContain('+after');
      expect(
        changes.find((change) => change.path === 'untracked.txt')?.diff,
      ).toContain('+brand new');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('reads a file whose name is not ASCII, rather than its escape', async () => {
    // `core.quotePath` is ON by default, so git escapes such a path
    // (`"caf\303\251.ts"`). That form reaches the screen AND is fed back to git
    // as an argument, where it names no file — so the row would show an escape
    // and carry no diff.
    const sha = initRepo();
    writeFileSync(join(dir, 'café.ts'), 'const x = 1;\n');

    const { changes } = await readChangesSince(dir, sha);

    const row = changes.find((change) => change.path === 'café.ts');
    expect(row).toBeDefined();
    expect(row?.diff).toContain('const x = 1;');
  });

  it('caps ONE file’s diff, and says where it cut', async () => {
    // The renderer draws a DOM node per line, synchronously, when a row is
    // expanded — so an uncapped body is an unbounded element count on one click.
    // Nothing else along the path bounds it: `MAX_CHANGES` counts FILES and the
    // `maxBuffer` is per invocation rather than a payload budget.
    const sha = initRepo();
    writeFileSync(
      join(dir, 'README.md'),
      `${Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n')}\n`,
    );

    const { changes } = await readChangesSince(dir, sha);
    const body = changes[0]!.diff!;

    expect(body.split('\n').length).toBeLessThan(2_100);
    expect(body).toContain('more lines');
  });

  it('caps an UNTRACKED file too — its body is the whole file', async () => {
    // The sharper half: an untracked body is `--no-index` against the empty
    // device, so it is the entire file rendered as additions and its size tracks
    // the FILE rather than the change. A generated bundle sitting untracked in
    // the tree is an ordinary thing to meet here.
    const sha = initRepo();
    writeFileSync(
      join(dir, 'bundle.js'),
      `${Array.from({ length: 5_000 }, (_, i) => `const x${i} = ${i};`).join('\n')}\n`,
    );

    const { changes } = await readChangesSince(dir, sha);
    const body = changes.find((change) => change.path === 'bundle.js')!.diff!;

    expect(body.split('\n').length).toBeLessThan(2_100);
    expect(body).toContain('more lines');
  });

  it('counts the lines a change adds and removes', async () => {
    const sha = initRepo();
    // REPLACING the one line it had, so both sides are non-zero — appending
    // would leave `hello` as unchanged context and pin only the added side.
    writeFileSync(join(dir, 'README.md'), 'first\nsecond\nthird\n');

    const { changes } = await readChangesSince(dir, sha);

    expect(changes).toEqual([
      expect.objectContaining({ path: 'README.md', added: 3, removed: 1 }),
    ]);
  });

  it('counts a NEW file’s whole length, since all of it is an addition', async () => {
    const sha = initRepo();
    writeFileSync(join(dir, 'fresh.txt'), 'a\nb\nc\nd\n');

    const { changes } = await readChangesSince(dir, sha);

    expect(changes).toContainEqual(
      expect.objectContaining({ path: 'fresh.txt', added: 4, removed: 0 }),
    );
  });

  it('counts the WHOLE change even where the body was capped for display', async () => {
    // The trap this ordering exists for: `boundedDiff` truncates at
    // MAX_DIFF_LINES, so counting after it would under-state exactly the large
    // change a reader most wants the true figure for.
    //
    // BOTH arms, because they are two separate push sites that each call the
    // counter with their own body — a first draft of this case used only an
    // untracked file, and a mutation moving the TRACKED site to count the
    // capped body left it green.
    const lines = (n: number): string =>
      Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';
    const sha = initRepo();
    writeFileSync(join(dir, 'README.md'), lines(3_000));
    writeFileSync(join(dir, 'fresh.txt'), lines(3_000));

    const { changes } = await readChangesSince(dir, sha);
    const tracked = changes.find((change) => change.path === 'README.md');
    const untracked = changes.find((change) => change.path === 'fresh.txt');

    expect(tracked?.added).toBe(3_000);
    expect(untracked?.added).toBe(3_000);
    // …while the bodies they will draw really were cut.
    expect(tracked?.diff?.split('\n').length).toBeLessThan(2_100);
    expect(untracked?.diff?.split('\n').length).toBeLessThan(2_100);
  });

  it('answers null rather than +0 −0 for a BINARY file', async () => {
    // A binary diff carries no hunk header, so there is nothing to count — and
    // `+0 −0` would assert a file changed by nothing, which is the one thing
    // the figure must never say.
    const sha = initRepo();
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    run(['add', '-A']);

    const { changes } = await readChangesSince(dir, sha);

    expect(changes).toContainEqual(
      expect.objectContaining({ path: 'blob.bin', added: null, removed: null }),
    );
  });

  it('leaves the counts null for an untracked file past the body budget', async () => {
    // No body was read, so nothing counted it. Guessing a length would be the
    // only fabricated figure on the screen.
    const sha = initRepo();
    for (let i = 0; i < 30; i += 1) {
      writeFileSync(join(dir, `n${String(i).padStart(2, '0')}.txt`), 'new\n');
    }

    const { changes } = await readChangesSince(dir, sha);

    expect(changes.filter((change) => change.added !== null)).toHaveLength(25);
  });

  it('names a RENAME by where the file ended up', async () => {
    // Rename detection is git's own default, so this arm is reached by an
    // ordinary `git mv` — and the `--name-status` line carries TWO paths, of
    // which the second is the one worth listing.
    const sha = initRepo();
    run(['mv', 'README.md', 'GUIDE.md']);

    const { changes } = await readChangesSince(dir, sha);

    expect(changes).toEqual([
      expect.objectContaining({ path: 'GUIDE.md', status: 'renamed' }),
    ]);
  });

  it('names a COPY, which only a repository that asked for it produces', async () => {
    // `C` is unreachable under git's defaults — copy detection is off — so the
    // branch would be dead code but for a repository setting `diff.renames` to
    // `copies`, which is a real thing to find in a checkout somebody else set
    // up. That config is deliberately NOT among the ones `SAFE_CONFIG` refuses:
    // it changes what git reports, never what git RUNS.
    const sha = initRepo();
    run(['config', 'diff.renames', 'copies']);
    writeFileSync(join(dir, 'COPY.md'), 'hello\n');
    // The source has to move as well, or there is no diff for git to find the
    // copy's origin in.
    writeFileSync(join(dir, 'README.md'), 'hello again\n');
    run(['add', '-A']);

    const { changes } = await readChangesSince(dir, sha);

    expect(changes).toContainEqual(
      expect.objectContaining({ path: 'COPY.md', status: 'copied' }),
    );
  });

  it('caps the LIST, and says it did', async () => {
    // `MAX_CHANGES` counts files, and past it the list stops being something a
    // person reads. Saying so is the whole of the flag: a silently truncated
    // list reads as a complete one.
    const sha = initRepo();
    for (let i = 0; i < 520; i += 1) {
      writeFileSync(join(dir, `f${String(i).padStart(4, '0')}.txt`), 'x\n');
    }

    const { changes, truncated } = await readChangesSince(dir, sha);

    expect(changes).toHaveLength(500);
    expect(truncated).toBe(true);
  });

  it('gives only the first few NEW files a body, and still lists the rest', async () => {
    // Each untracked body costs its own git call, so they are capped well below
    // the list — but the cap must cost the BODY and never the row: a tree with
    // thirty new files in it has thirty new files in it.
    const sha = initRepo();
    for (let i = 0; i < 30; i += 1) {
      writeFileSync(join(dir, `n${String(i).padStart(2, '0')}.txt`), 'new\n');
    }

    const { changes, truncated } = await readChangesSince(dir, sha);

    expect(changes).toHaveLength(30);
    expect(truncated).toBe(false);
    expect(changes.filter((change) => change.diff !== null)).toHaveLength(25);
  });

  it('lists only what is uncommitted once the checkout LEFT the start commit', async () => {
    // REPORTED as "500 files that were not changed at all": a review chat that
    // checked out the pull request it was reviewing. Its start commit was then
    // on another branch, so the tree against it differed in every file the two
    // branches disagree on — none of them this chat's work.
    initRepo();
    run(['checkout', '-q', '-b', 'side']);
    writeFileSync(join(dir, 'side-only.txt'), 'on the side branch\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'side work']);
    const started = run(['rev-parse', 'HEAD']);
    run(['checkout', '-q', 'main']);
    writeFileSync(join(dir, 'README.md'), 'edited after the move\n');

    const result = await readChangesSince(dir, started);

    expect(result.movedOffStart).toBe(true);
    // The branch difference is NOT listed; the uncommitted edit is.
    expect(result.changes.map((change) => change.path)).toEqual(['README.md']);
  });

  /** A bare repository standing in for GitHub, wired up as `origin`. */
  function addOrigin(): string {
    const remote = mkdtempSync(join(tmpdir(), 'geniro-origin-'));
    execFileSync('git', ['init', '--bare', '-q', remote], { cwd: tmpdir() });
    run(['remote', 'add', 'origin', remote]);
    return remote;
  }

  function commitFile(name: string, text: string, message: string): string {
    writeFileSync(join(dir, name), text);
    run(['add', '.']);
    run(['commit', '-q', '-m', message]);
    return run(['rev-parse', 'HEAD']);
  }

  it('leaves out what a PULL brought in, measuring against the newest commit shared with the remote', async () => {
    // REPORTED as "a lot of strange changes": a chat fast-forwarded `main` by 51
    // upstream commits and edited ten files of its own, and the dialog listed
    // 194. The checkout still descends from the start, so the branch-switch
    // guard cannot help — the newest commit HEAD shares with the remote's
    // default branch is where the chat's own work begins.
    const started = initRepo();
    const remote = addOrigin();
    try {
      // Upstream work that reached the remote's main after the chat began.
      commitFile('upstream.txt', 'someone else\n', 'upstream');
      run(['push', '-q', 'origin', 'main']);
      const shared = run(['rev-parse', 'origin/main']);
      // The chat's own work: a commit the remote does not hold, and an edit.
      commitFile('mine.txt', 'this chat\n', 'mine');
      writeFileSync(join(dir, 'README.md'), 'edited\n');

      const result = await readChangesSince(dir, started);

      // Named by the ref it came through — this repository has no
      // `origin/HEAD`, so the fallback to `origin/main` is what answered.
      expect(result.upstreamBase).toEqual({ sha: shared, ref: 'origin/main' });
      expect(result.movedOffStart).toBe(false);
      // `upstream.txt` is NOT listed; the chat's own commit and edit are.
      expect(result.changes.map((change) => change.path)).toEqual([
        'mine.txt',
        'README.md',
      ]);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('counts a commit pulled into the checkout against the start commit, so merged work stays in the total', async () => {
    // The thread's own commit reaches the remote's default branch, and the checkout's upstream
    // base moves onto it: the changes panel then lists nothing, but the stats total must not
    // fall. The ledger's high-water rule depends on the basis not moving.
    const started = initRepo();
    const remote = addOrigin();
    try {
      commitFile('mine.txt', 'this chat\n', 'mine');
      const beforeMerge = await readChangesTotals(dir, started);
      run(['push', '-q', 'origin', 'main']);
      const afterMerge = await readChangesTotals(dir, started);

      expect(beforeMerge).toMatchObject({ linesAdded: 1, linesRemoved: 0 });
      expect(afterMerge).toMatchObject({ linesAdded: 1, linesRemoved: 0 });
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('keeps the start as the base when the remote holds nothing newer than it', async () => {
    const started = initRepo();
    const remote = addOrigin();
    try {
      run(['push', '-q', 'origin', 'main']);
      commitFile('mine.txt', 'this chat\n', 'mine');

      const result = await readChangesSince(dir, started);

      expect(result.upstreamBase).toBeNull();
      expect(result.changes.map((change) => change.path)).toEqual(['mine.txt']);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('keeps the start as the base when the remote is BEHIND it', async () => {
    // A chat begun on a branch already ahead of the remote: the shared commit
    // is older than the start, and measuring against it would put the work
    // from before the chat back into the list.
    initRepo();
    const remote = addOrigin();
    try {
      run(['push', '-q', 'origin', 'main']);
      const started = commitFile('before.txt', 'earlier\n', 'before the chat');
      commitFile('mine.txt', 'this chat\n', 'mine');

      const result = await readChangesSince(dir, started);

      expect(result.upstreamBase).toBeNull();
      expect(result.changes.map((change) => change.path)).toEqual(['mine.txt']);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('says the commit is gone rather than reporting no changes', async () => {
    // A rewritten history — a rebase, a reset, a re-cloned checkout — is the one
    // case where an empty diff would be a lie: the tree may have changed
    // entirely, and there is no longer anything to measure it against.
    initRepo();

    const result = await readChangesSince(dir, 'b'.repeat(40));

    expect(result.changes).toEqual([]);
    expect(result.unavailableReason).toContain('no longer in this checkout');
  });

  it('says a plain folder is not a repository', async () => {
    const result = await readChangesSince(dir, 'c'.repeat(40));

    expect(result.unavailableReason).toBe('Not a git repository.');
  });
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

  it('marks the total partial when the list was cut, though every file in it was counted', async () => {
    // Tracked files, because every one of those has a body: no count is missing,
    // so the cut is the only reason this total can fall short. Untracked files
    // past the first 25 carry no counts and would mark it partial on their own.
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

    // Only the 500 files the list kept are summed.
    expect(await readChangesTotals(dir, sha)).toEqual({
      linesAdded: 500,
      linesRemoved: 500,
      partial: true,
    });
  });

  it('answers null, not zeros, when the changes could not be read', async () => {
    // A rewritten history is where zeros would do the most harm: the tree may
    // have changed entirely, and nothing is left to measure it against.
    initRepo();

    expect(await readChangesTotals(dir, 'b'.repeat(40))).toBeNull();
  });

  it('answers zeros, not null, for a tree nothing has changed in', async () => {
    const sha = initRepo();

    expect(await readChangesTotals(dir, sha)).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
      partial: false,
    });
  });

  it('answers null, not a total against HEAD, once the checkout has left the start commit', async () => {
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

    expect(await readChangesTotals(dir, started)).toBeNull();
  });

  it('answers null when every change is one that cannot be counted', async () => {
    // A binary file's lines cannot be counted. "+0 −0" would claim the thread changed
    // nothing, when its only change is one nothing could count.
    const sha = initRepo();
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    run(['add', '-A']);

    expect(await readChangesTotals(dir, sha)).toBeNull();
  });
});

describe('the read-only config', () => {
  it('does not run the repository’s own post-index-change hook on a read', async () => {
    // A read can rewrite the index, and git then runs `post-index-change` from the
    // folder's own hooks directory: a program the repository chose, run as the user.
    // The read config points hooks elsewhere. Without that, the hook ran on `diff`.
    const sha = initRepo();
    const markerDir = mkdtempSync(join(tmpdir(), 'geniro-hook-marker-'));
    const marker = join(markerDir, 'ran');
    const hook = join(dir, '.git', 'hooks', 'post-index-change');
    writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\n`);
    chmodSync(hook, 0o755);
    // A timestamp change alone is what makes git rewrite the index on the next read.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'README.md'), later, later);

    try {
      // The control: a plain read runs the hook, so the marker proves the guarded read stopped
      // it, and was not a machine on which the hook never ran at all.
      run(['diff']);
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      // The control read refreshed the index, so the file gets a LATER mtime for the guarded read.
      // A second with the same mtime is not a change git notices, and the guard would go untested.
      const touched = new Date(later.getTime() + 1_000);
      utimesSync(join(dir, 'README.md'), touched, touched);

      await readChangesSince(dir, sha);

      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  });
});
