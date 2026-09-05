import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readChangesSince } from './git-changes';

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
