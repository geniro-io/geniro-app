import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GitChange, GitChanges } from '../shared/contracts';

const execFileAsync = promisify(execFile);

/**
 * Its own budget, and that is why this is not `git-info.ts`.
 *
 * That module reads local refs for a chip the composer draws on every folder
 * change, so it is tuned to never make the user wait; a diff against a commit
 * from days ago walks the whole tree and returns text rather than a word. The
 * same split `github-prs.ts` already documents for the opposite reason — a
 * network client on a longer leash.
 */
const DIFF_TIMEOUT_MS = 20_000;

/**
 * How much one INVOCATION of git may return — a child-process `maxBuffer`, not
 * a budget for the payload.
 *
 * The distinction decides how this fails. The tracked half is ONE call for the
 * whole diff, so overflowing it is all-or-nothing: node throws
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, which is not {@link EXIT_DIFFERENT}, so
 * the catch answers null, `bodies` is empty and EVERY row degrades to the "no
 * diff for this file" state at once. The untracked half is one call per file, so
 * each gets its own budget. What bounds what a reader actually receives is
 * {@link MAX_DIFF_LINES}, applied per body.
 */
const DIFF_MAX_BYTES = 8 * 1024 * 1024;

/** Beyond this the list stops being something a person reads. */
const MAX_CHANGES = 500;

/**
 * How many NEW files get their contents shown. Each costs its own git call, and
 * a tree with hundreds of untracked files is a build output directory rather
 * than work somebody wants to read.
 */
const MAX_UNTRACKED_BODIES = 25;

/**
 * How many lines of ONE file's diff are carried.
 *
 * The renderer draws a DOM node per line, synchronously, when a row is
 * expanded — so an uncapped body is an unbounded element count on one click.
 * Nothing else along the path bounds it: `MAX_CHANGES` counts FILES,
 * `DIFF_MAX_BYTES` is a per-invocation `maxBuffer` rather than a payload budget,
 * and neither the IPC layer nor the dialog truncates.
 *
 * The untracked arm is what makes the cap necessary rather than tidy: those
 * bodies are `--no-index` against the empty device, so each is the WHOLE file
 * rendered as additions and its size tracks the file rather than the change. A
 * generated bundle or a checked-in fixture sitting untracked in the tree is an
 * ordinary thing to meet here.
 *
 * 2,000 lines is well past any diff a person reads in a dialog and comfortably
 * over the largest single-file change in this repository's history (6,952 lines
 * was a full lockfile rewrite), so what it truncates is the case nobody was
 * going to read anyway.
 */
const MAX_DIFF_LINES = 2_000;

/** One body, cut to {@link MAX_DIFF_LINES} and SAYING so where it was cut. */
function boundedDiff(diff: string | null): string | null {
  if (diff === null) {
    return null;
  }
  const lines = diff.split('\n');
  if (lines.length <= MAX_DIFF_LINES) {
    return diff;
  }
  // The notice goes IN the body rather than on a field of its own: it belongs
  // at the point of the cut, where a reader meets it, and the alternative is a
  // wire field every consumer has to remember to render.
  return [
    ...lines.slice(0, MAX_DIFF_LINES),
    '',
    `… ${lines.length - MAX_DIFF_LINES} more lines — open the file to read the rest.`,
  ].join('\n');
}

/**
 * Config this view refuses to honour, prepended to every invocation.
 *
 * `.git/config` is data that travels with a repository — an archive, a clone, a
 * folder an agent was pointed at — and `core.fsmonitor` names a command git
 * starts on any read. Opening a read-only view of what changed must not run
 * something the folder asked for.
 *
 * `core.quotePath=false` is here for a different reason and is not defensive: on
 * by default, it escapes any non-ASCII path (`"caf\303\251.ts"`), and this code
 * feeds a path from one git command as an ARGUMENT to another — where the
 * escaped form names no file. It also reaches the screen, so a user would read
 * the escape rather than the file name.
 *
 * The OTHER two command-running keys — `diff.external` and a `textconv` driver —
 * are refused by {@link SAFE_DIFF} instead, and the difference is not stylistic:
 * `-c diff.external=` does not disable an external diff, it sets one to the
 * empty command, and git then dies with `cannot run : No such file or directory`
 * on every file. Measured.
 */
const SAFE_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
  // `diff.relative` is the third travelling key, and it silently undoes the path
  // agreement below: set, `diff` reports paths relative to the CWD and covers
  // only its subtree, while `ls-files --full-name :/` beside it stays
  // repo-relative and whole-repo. Measured in this checkout from `apps/ui`:
  // 38 changed files reported against 68 without it — thirty gone, and the
  // survivors carrying a different path base from the untracked rows.
  '-c',
  'diff.relative=false',
];

/**
 * The two flags that make `diff` produce a diff rather than run the repository's
 * chosen program — a `diff.external` command in place of the diff, or a
 * `textconv` filter over each blob.
 *
 * Verified against a repo configured with `diff.external = /bin/false`: with
 * these the diff is produced normally.
 */
const SAFE_DIFF = ['--no-ext-diff', '--no-textconv'];

/** git's exit status for "the inputs differ" — an outcome, not a failure. */
const EXIT_DIFFERENT = 1;

/** One git command, tolerating the exit status `diff` uses to mean "differs". */
async function git(
  dir: string,
  args: string[],
  tolerateDifferent = false,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...SAFE_CONFIG, ...args], {
      cwd: dir,
      timeout: DIFF_TIMEOUT_MS,
      maxBuffer: DIFF_MAX_BYTES,
    });
    return stdout;
  } catch (error) {
    // `git diff --no-index` exits 1 when the inputs DIFFER, which is the
    // ordinary outcome for the caller that asks — and the output we want is on
    // the error. ONLY that status: 128 is a genuine git failure (a bad object, a
    // missing file) whose partial stdout would be read here as a real answer.
    if (
      tolerateDifferent &&
      error instanceof Error &&
      'code' in error &&
      (error as { code?: unknown }).code === EXIT_DIFFERENT
    ) {
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === 'string') {
        return stdout;
      }
    }
    return null;
  }
}

/** git's own status letters, in the words the view shows. */
function statusOf(letter: string): GitChange['status'] {
  switch (letter[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return 'modified';
  }
}

/**
 * Split one unified diff into its per-file bodies, keyed by the path git names.
 *
 * The whole diff is taken in ONE call and cut up here rather than asked for a
 * file at a time: a branch's worth of work is hundreds of files, and that many
 * subprocesses is the difference between a view that opens and one that hangs.
 */
function splitDiff(diff: string): Map<string, string> {
  const bodies = new Map<string, string>();
  // `b/<path>` rather than `a/<path>`: for a rename the second is where the file
  // ended up, which is what `--name-status` reports and what the list shows.
  const header = /^diff --git a\/.+ b\/(.+)$/;
  let path: string | null = null;
  let lines: string[] = [];
  const flush = (): void => {
    if (path !== null) {
      bodies.set(path, lines.join('\n'));
    }
  };
  for (const line of diff.split('\n')) {
    const match = header.exec(line);
    if (match) {
      flush();
      path = match[1]!;
      lines = [line];
      continue;
    }
    if (path !== null) {
      lines.push(line);
    }
  }
  flush();
  return bodies;
}

/**
 * How many lines one file's diff adds and removes.
 *
 * Counted from the BODY rather than asked of `git diff --numstat`, and that is a
 * choice with two reasons rather than a shortcut. The body is already in hand
 * for every file — `splitDiff` keyed it by the path git itself names — so this
 * costs no fourth subprocess. And numstat renders a RENAME as
 * `old.txt => new.txt` (or the `dir/{a => b}.txt` brace form), which would have
 * to be parsed back into the single path `--name-status` reports before the two
 * lists could be joined at all; counting sidesteps a match that has a wrong
 * answer available.
 *
 * It must be given the RAW body, never {@link boundedDiff}'s: that one truncates
 * at {@link MAX_DIFF_LINES}, so a capped file would report the count of the part
 * that survived and quietly under-state a large change — the figure a reader
 * most wants to be true.
 *
 * A missing body and a BINARY one both answer null, which is "not measured"
 * rather than zero. Binary is detected by the absence of a hunk header: git
 * writes `Binary files a/x and b/x differ` and no `@@`, so counting it would
 * report a confident `+0 −0` about a file that certainly changed.
 */
export function countDiffLines(diff: string | null): {
  added: number | null;
  removed: number | null;
} {
  if (diff === null || !diff.includes('\n@@')) {
    return { added: null, removed: null };
  }
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    // `+++` / `---` are the file headers, not content. Checking the second
    // character is enough because a content line's own `+`/`-` is followed by
    // whatever the file holds, and a header's is followed by another of itself.
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed += 1;
    }
  }
  return { added, removed };
}

/**
 * What has changed in a folder since one commit — including files that were
 * created and never `git add`ed.
 *
 * READ-ONLY by construction: every command here reports, none writes. That is
 * not incidental — the obvious way to make an untracked file appear in a diff is
 * `git add -N`, which mutates the index of the user's own checkout, and a view
 * that exists to show what an agent did must not itself change the tree.
 *
 * The untracked half is the part a plain `git diff <sha>` silently drops, and
 * dropping it is the failure this pairing exists to prevent: an agent that wrote
 * a new file and did not stage it would show as having changed nothing.
 *
 * Every failure is ONE outcome — an empty list with a reason — on the rule
 * `readGitInfo` follows: a caller wants to know whether to draw a view, and half
 * an answer presented as a whole one is worse than none.
 */
export async function readChangesSince(
  dir: string,
  sha: string,
): Promise<GitChanges> {
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside === null || inside.trim() !== 'true') {
    return {
      changes: [],
      truncated: false,
      unavailableReason: 'Not a git repository.',
      movedOffStart: false,
    };
  }
  // Asked BEFORE the diff, because the sentence differs and the difference
  // matters: a commit git cannot resolve is a rewritten history (a rebase, a
  // reset, a re-cloned checkout), where an empty diff would read as "nothing has
  // changed" about a tree that may have changed entirely.
  const known = await git(dir, ['cat-file', '-e', `${sha}^{commit}`]);
  if (known === null) {
    return {
      changes: [],
      truncated: false,
      unavailableReason:
        'The commit this chat started at is no longer in this checkout — its history was rewritten or the folder was replaced.',
      movedOffStart: false,
    };
  }
  // Whether the checkout still DESCENDS from that commit. When it does not — a
  // branch switched, a pull request checked out for review — diffing the tree
  // against the start commit lists every file that differs between two
  // branches, none of which this chat touched: REPORTED as "500 files that were
  // not changed at all" on a review chat that had checked out the PR it was
  // reviewing. Measured against HEAD instead, the list is what is uncommitted
  // NOW, and `movedOffStart` lets the view say why.
  const descends =
    (await git(dir, ['merge-base', '--is-ancestor', sha, 'HEAD'])) !== null;
  const base = descends ? sha : 'HEAD';

  // Both halves must speak the SAME path language over the SAME scope, and by
  // default they do not: `diff` reports repo-root-relative paths for the whole
  // repository, while `ls-files` reports cwd-relative paths for the cwd's
  // subtree alone. A chat opened in `apps/ui` of a monorepo would list a change
  // as `apps/ui/x.ts` and a new file as `x.ts` — one list, two meanings, and
  // identical basenames colliding on the row key — while a new file written
  // elsewhere in the repo vanished entirely, which is the exact loss pairing
  // `ls-files` with the diff exists to prevent. `--full-name` fixes the
  // language and the `:/` pathspec fixes the scope.
  const [names, diff, others] = await Promise.all([
    git(dir, ['diff', ...SAFE_DIFF, '--name-status', base]),
    git(dir, ['diff', ...SAFE_DIFF, base]),
    git(dir, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--full-name',
      ':/',
    ]),
  ]);
  if (names === null || others === null) {
    return {
      changes: [],
      truncated: false,
      unavailableReason: 'git could not read this folder’s changes.',
      movedOffStart: false,
    };
  }

  const bodies = diff === null ? new Map<string, string>() : splitDiff(diff);
  const changes: GitChange[] = [];
  for (const line of names.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    // Tab-separated, and a RENAME carries two paths — the second is where the
    // file is now, which is the one worth showing.
    const parts = line.split('\t');
    const letter = parts[0] ?? '';
    const path = parts[parts.length - 1] ?? '';
    if (path === '') {
      continue;
    }
    const body = bodies.get(path) ?? null;
    changes.push({
      path,
      status: statusOf(letter),
      diff: boundedDiff(body),
      // From the RAW body, ahead of the cap — see `countDiffLines`.
      ...countDiffLines(body),
    });
  }

  const untracked = others.split('\n').filter((path) => path.trim() !== '');
  // Every path is repo-root-relative now, so the bodies must be read FROM the
  // repo root — `dir` may be a subdirectory of it. A root that cannot be
  // resolved costs the bodies and never the listing.
  const root = (await git(dir, ['rev-parse', '--show-toplevel']))?.trim() ?? '';
  // In PARALLEL: each is an independent process spawn, and serialised they add a
  // fixed stall to every open of this view — the same reason the three reads
  // above share one `Promise.all`, and the one `splitDiff` gives for taking the
  // tracked diff in a single call.
  const bodyList = await Promise.all(
    untracked
      .slice(0, MAX_UNTRACKED_BODIES)
      .map((path): Promise<string | null> =>
        root === ''
          ? Promise.resolve(null)
          : // `--no-index` against the empty device is the read-only way to
            // render a new file as an addition; `git add -N` would do it by
            // writing to the user's index, which this view may not do.
            git(
              root,
              ['diff', ...SAFE_DIFF, '--no-index', '--', '/dev/null', path],
              true,
            ),
      ),
  );
  for (const [index, path] of untracked.entries()) {
    const body = bodyList[index] ?? null;
    changes.push({
      path,
      status: 'untracked',
      diff: boundedDiff(body),
      // Null past `MAX_UNTRACKED_BODIES`, which is the honest answer: no body
      // was read, so nothing counted it. A new file's count is its whole length,
      // and guessing one would be the only fabricated figure on the screen.
      ...countDiffLines(body),
    });
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return {
    changes: changes.slice(0, MAX_CHANGES),
    truncated: changes.length > MAX_CHANGES,
    unavailableReason: null,
    movedOffStart: !descends,
  };
}
