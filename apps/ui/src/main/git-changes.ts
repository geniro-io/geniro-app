import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  ChangesBaseUnreachable,
  ChangesTotals,
  GitChange,
  GitChanges,
  GitUpstreamBase,
} from '../shared/contracts';
import { IGNORE_SUBMODULE_WORKTREES, readSafeConfig } from './git-safe-config';

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
 * Config this view adds to `git-safe-config.ts`'s {@link readSafeConfig} —
 * which refuses the two keys that name a PROGRAM git would run on a read
 * (`core.fsmonitor`, and every filter driver the repository defines) and turns
 * `core.quotePath` off. That last one matters more here than anywhere: this
 * code feeds a path from one git command as an ARGUMENT to another, where the
 * escaped form names no file.
 *
 * The OTHER two command-running keys — `diff.external` and a `textconv` driver —
 * are refused by {@link SAFE_DIFF} instead, and the difference is not stylistic:
 * `-c diff.external=` does not disable an external diff, it sets one to the
 * empty command, and git then dies with `cannot run : No such file or directory`
 * on every file. Measured.
 */
const VIEW_CONFIG = [
  // `diff.relative` is a travelling key that silently undoes the path
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
  config: readonly string[],
  tolerateDifferent = false,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...config, ...args], {
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

/**
 * The exit status of one git command, or null when there is none to read: it timed out, could
 * not be spawned, or was killed. For the two questions below whose ANSWER is the status, where
 * reading every failure as "no" would act on a git error as though it were a fact.
 */
async function gitExitCode(
  dir: string,
  args: string[],
  config: readonly string[],
): Promise<number | null> {
  try {
    await execFileAsync('git', [...config, ...args], {
      cwd: dir,
      timeout: DIFF_TIMEOUT_MS,
      maxBuffer: DIFF_MAX_BYTES,
    });
    return 0;
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    return typeof code === 'number' ? code : null;
  }
}

/**
 * git's exit status for "no" from a command whose answer IS its status: `rev-parse --verify
 * --quiet` naming no such commit, `merge-base --is-ancestor` finding no ancestry. A failure
 * of git itself exits 128.
 */
const EXIT_NO = 1;

/**
 * The config every read of a folder's changes runs under, or why there is none: a repository
 * whose own filters cannot be neutralised is not read at all, since every diff would run them.
 * Shared by both readers, so a hardening of this step reaches both.
 */
async function openRepository(
  dir: string,
): Promise<{ config: readonly string[] } | 'unsafe' | 'not-repo'> {
  const safe = await readSafeConfig(dir, DIFF_TIMEOUT_MS);
  if (safe === null) {
    return 'unsafe';
  }
  const config = [...safe, ...VIEW_CONFIG];
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree'], config);
  if (inside === null || inside.trim() !== 'true') {
    return 'not-repo';
  }
  return { config };
}

/**
 * Where the checkout stands relative to `sha`: it still descends from it, it has moved off it
 * (a branch switched, a rebase), or the commit is not in the repository at all (a rewritten
 * history, a re-cloned folder). Null when git failed to answer, which is none of those and
 * must not be acted on as one.
 */
async function baseRelation(
  dir: string,
  sha: string,
  config: readonly string[],
): Promise<'descends' | 'diverged' | 'missing' | null> {
  const known = await gitExitCode(
    dir,
    ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`],
    config,
  );
  if (known === EXIT_NO) {
    return 'missing';
  }
  if (known !== 0) {
    return null;
  }
  const ancestor = await gitExitCode(
    dir,
    ['merge-base', '--is-ancestor', sha, 'HEAD'],
    config,
  );
  if (ancestor === 0) {
    return 'descends';
  }
  return ancestor === EXIT_NO ? 'diverged' : null;
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
 * A missing body answers null, which is "not measured" rather than zero. So does a BINARY
 * one: git writes `Binary files a/x and b/x differ` (or a `GIT binary patch`) and no hunk,
 * and counting that as `+0 −0` would be a confident figure about a file that certainly
 * changed. A body with no hunk and no such line is a change of mode, a rename or an empty
 * file, which adds and removes no lines, so it counts as zero.
 *
 * Only the lines AFTER the first hunk header are content. The lines before it are the file
 * header (`---`, `+++`, mode and rename lines), and a prefix test over the whole body would
 * drop a removed `-- comment` (it reads `--- comment`) and an added `++n`.
 */
export function countDiffLines(diff: string | null): {
  added: number | null;
  removed: number | null;
} {
  if (diff === null || /^(Binary files |GIT binary patch$)/m.test(diff)) {
    return { added: null, removed: null };
  }
  const firstHunk = diff.search(/^@@/m);
  if (firstHunk === -1) {
    return { added: 0, removed: 0 };
  }
  let added = 0;
  let removed = 0;
  for (const line of diff.slice(firstHunk).split('\n')) {
    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      removed += 1;
    }
  }
  return { added, removed };
}

/**
 * The default branch of the `origin` remote, as a ref this checkout holds — or
 * null for a repository with no such remote.
 *
 * `origin/HEAD` is what a clone records; a repository that was `git init`ed
 * and then given a remote never has it, so the two usual names are tried
 * behind it rather than treating its absence as "no upstream".
 */
async function defaultRemoteBranch(
  dir: string,
  config: readonly string[],
): Promise<string | null> {
  for (const ref of [
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
  ]) {
    const found = await git(
      dir,
      ['rev-parse', '--verify', '--quiet', ref],
      config,
    );
    if (found !== null && found.trim() !== '') {
      return ref;
    }
  }
  return null;
}

/**
 * The commit to measure against INSTEAD of the chat's start, once the checkout
 * shares newer history with the remote than the start — and the ref it was
 * found through — or null when the start is still the right base.
 *
 * A pull keeps HEAD descending from the start, so the branch-switch guard in
 * {@link readChangesSince} never fires, and a diff against the start then
 * lists every file the pulled commits touched: REPORTED as "a lot of strange
 * changes" on a chat that had fast-forwarded `main` by 51 upstream commits and
 * edited ten files of its own — the dialog listed 194. None of the 184 were
 * this chat's work, and nothing on screen said which ten were.
 *
 * The newest commit HEAD shares with the default remote branch is where the
 * chat's own work begins: everything at or below it is already upstream. That
 * is true whether it got there by a pull or by the chat's own commits being
 * merged, which is why the answer names the REF rather than a cause — the
 * dialog cannot tell the two apart and must not claim either. It is used only
 * when it lies AT OR PAST the start — a stale remote ref, or a chat begun on a
 * branch already ahead of the remote, answers with an older commit, and
 * measuring against that would put upstream's own changes back in. A
 * repository with no remote, or one whose shared commit IS the start, keeps
 * the start.
 */
async function upstreamBaseSince(
  dir: string,
  sha: string,
  config: readonly string[],
): Promise<GitUpstreamBase | null> {
  const remote = await defaultRemoteBranch(dir, config);
  if (remote === null) {
    return null;
  }
  const shared = (
    await git(dir, ['merge-base', 'HEAD', remote], config)
  )?.trim();
  if (shared === undefined || shared === '' || shared === sha) {
    return null;
  }
  const pastStart =
    (await git(dir, ['merge-base', '--is-ancestor', sha, shared], config)) !==
    null;
  if (!pastStart) {
    return null;
  }
  // `origin/HEAD` names the branch it points at (`origin/master`), which is the
  // word a reader recognises; a ref that will not abbreviate keeps its own.
  const name = (
    await git(dir, ['rev-parse', '--abbrev-ref', remote], config)
  )?.trim();
  return {
    sha: shared,
    ref: name || remote.replace(/^refs\/remotes\//, ''),
  };
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
  const unreadable = (unavailableReason: string): GitChanges => ({
    changes: [],
    truncated: false,
    unavailableReason,
    movedOffStart: false,
    upstreamBase: null,
  });
  const repository = await openRepository(dir);
  if (repository === 'unsafe') {
    return unreadable('git could not read this folder’s changes.');
  }
  if (repository === 'not-repo') {
    return unreadable('Not a git repository.');
  }
  const { config } = repository;
  // Asked BEFORE the diff, because the sentence differs and the difference
  // matters: a commit git cannot resolve is a rewritten history (a rebase, a
  // reset, a re-cloned checkout), where an empty diff would read as "nothing has
  // changed" about a tree that may have changed entirely.
  const relation = await baseRelation(dir, sha, config);
  if (relation === null) {
    return unreadable('git could not read this folder’s changes.');
  }
  if (relation === 'missing') {
    return unreadable(
      'The commit this chat started at is no longer in this checkout — its history was rewritten or the folder was replaced.',
    );
  }
  // Whether the checkout still DESCENDS from that commit. When it does not — a
  // branch switched, a pull request checked out for review — diffing the tree
  // against the start commit lists every file that differs between two
  // branches, none of which this chat touched: REPORTED as "500 files that were
  // not changed at all" on a review chat that had checked out the PR it was
  // reviewing. Measured against HEAD instead, the list is what is uncommitted
  // NOW, and `movedOffStart` lets the view say why.
  const descends = relation === 'descends';
  // A checkout that PULLED still descends — see `upstreamBaseSince`.
  const upstreamBase = descends
    ? await upstreamBaseSince(dir, sha, config)
    : null;
  const base = descends ? (upstreamBase?.sha ?? sha) : 'HEAD';

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
    git(
      dir,
      ['diff', ...SAFE_DIFF, IGNORE_SUBMODULE_WORKTREES, '--name-status', base],
      config,
    ),
    git(dir, ['diff', ...SAFE_DIFF, IGNORE_SUBMODULE_WORKTREES, base], config),
    git(
      dir,
      ['ls-files', '--others', '--exclude-standard', '--full-name', ':/'],
      config,
    ),
  ]);
  if (names === null || others === null) {
    return {
      changes: [],
      truncated: false,
      unavailableReason: 'git could not read this folder’s changes.',
      movedOffStart: false,
      upstreamBase: null,
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
  const root =
    (await git(dir, ['rev-parse', '--show-toplevel'], config))?.trim() ?? '';
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
            // Under the same config: a new file matching a `.gitattributes`
            // filter line runs that filter here too — measured.
            git(
              root,
              ['diff', ...SAFE_DIFF, '--no-index', '--', '/dev/null', path],
              config,
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
    upstreamBase,
  };
}

/**
 * How many untracked files a total reads to count their lines. A tree with more is a build
 * output directory rather than work, and the total says it is a floor.
 */
const MAX_UNTRACKED_COUNTED = 2_000;

/**
 * The largest untracked file whose lines are counted. Past it a file is a log, a dump or a
 * generated bundle rather than lines somebody wrote, and reading it after every turn would
 * cost the Electron process its whole size each time; it is left out and the total is a floor.
 */
const MAX_UNTRACKED_FILE_BYTES = 4 * 1024 * 1024;

/** How many untracked files are read at once. */
const UNTRACKED_READ_CONCURRENCY = 8;

/** The prefix git reads to decide a file is binary. */
const BINARY_PROBE_BYTES = 8_000;

/**
 * How long the untracked half of one total may take before the rest is left uncounted. Short,
 * because a quit waits on a measurement in flight (`LINE_FLUSH_TIMEOUT_MS`), and a tree whose
 * untracked files take longer than this to read is a build output rather than work.
 */
const UNTRACKED_READ_BUDGET_MS = 5_000;

/**
 * Lines in one untracked file, as `git diff --numstat` would count its addition: every
 * newline, plus a last line with none. Null for a file that is not counted: one git would
 * call binary (a NUL in its first {@link BINARY_PROBE_BYTES}), one past
 * {@link MAX_UNTRACKED_FILE_BYTES}, anything that is not a regular file or a symlink, and
 * anything reached after `deadline`.
 *
 * Read off disk rather than diffed against `/dev/null`: that is a process per file, and a
 * read runs none of the repository's filters. A symlink is one line, its target, which is
 * how git stores it, and is never followed — the file is opened with `O_NOFOLLOW`, so a link
 * swapped in after the `lstat` is refused rather than read, and `O_NONBLOCK`, so a pipe
 * swapped in cannot hold the open.
 */
async function untrackedLineCount(
  path: string,
  deadline: number,
  maxBytes: number,
  now: () => number,
): Promise<number | null> {
  if (now() > deadline) {
    return null;
  }
  let info;
  try {
    info = await lstat(path);
  } catch {
    return null;
  }
  if (info.isSymbolicLink()) {
    return 1;
  }
  if (!info.isFile() || info.size > maxBytes) {
    return null;
  }
  if (info.size === 0) {
    return 0;
  }
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) {
      return null;
    }
    let lines = 0;
    let last = 0;
    let probed = 0;
    // Bounded to the size that was checked: a file still being written (a log a background
    // command appends to) is read to where it stood, not chased as it grows.
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      start: 0,
      end: opened.size - 1,
    }) as AsyncIterable<Buffer>) {
      if (now() > deadline) {
        return null;
      }
      if (probed < BINARY_PROBE_BYTES) {
        const window = chunk.subarray(0, BINARY_PROBE_BYTES - probed);
        if (window.includes(0)) {
          return null;
        }
        probed += window.length;
      }
      for (
        let at = chunk.indexOf(0x0a);
        at !== -1;
        at = chunk.indexOf(0x0a, at + 1)
      ) {
        lines += 1;
      }
      last = chunk[chunk.length - 1] ?? last;
    }
    return last === 0x0a ? lines : lines + 1;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Runs `work` over every item, at most `limit` at a time, keeping the input order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * The lines a folder has added and removed since `sha`, tracked and untracked files
 * together.
 *
 * Counted, never diffed: the tracked half is one `git diff --numstat`, which reads no
 * bodies and so has no output budget to overflow, and the untracked half reads the files
 * themselves ({@link untrackedLineCount}).
 *
 * Measured against `sha` even after a pull: a commit that reaches the default branch stays
 * in the total, so a total never falls because work was merged. The cost is that commits a
 * pull brought in count toward the folder, which the Stats hint says.
 *
 * {@link ChangesBaseUnreachable} when git says `sha` is gone or the checkout no longer
 * descends from it: a total against HEAD would be another basis. Null when the read failed, and it has to
 * stay null: a failure answered as `+0 −0` claims nothing changed in a folder nobody could
 * read. Also null when changes exist but none of them could be counted.
 *
 * `partial` marks a total that is a floor: a binary file, or an untracked file that was not
 * read — past {@link MAX_UNTRACKED_COUNTED} files, past {@link MAX_UNTRACKED_FILE_BYTES}, or
 * past the read budget — is left out of the sums rather than guessed.
 */
export async function readChangesTotals(
  dir: string,
  sha: string,
  limits: {
    maxUntrackedFiles: number;
    maxUntrackedFileBytes: number;
    untrackedBudgetMs: number;
    /** The clock the budget is read against — injectable so a spec can pass the deadline mid-read. */
    now?: () => number;
  } = {
    maxUntrackedFiles: MAX_UNTRACKED_COUNTED,
    maxUntrackedFileBytes: MAX_UNTRACKED_FILE_BYTES,
    untrackedBudgetMs: UNTRACKED_READ_BUDGET_MS,
  },
): Promise<ChangesTotals | ChangesBaseUnreachable | null> {
  const repository = await openRepository(dir);
  if (typeof repository === 'string') {
    return null;
  }
  const { config } = repository;
  // Only an answer git actually GAVE moves the baseline: a folder that left the commit, or
  // a commit it no longer has. A failed check is unmeasured, never "unreachable" — the
  // caller replaces a baseline it is told is unreachable, and a timeout must not do that.
  const relation = await baseRelation(dir, sha, config);
  if (relation === null) {
    return null;
  }
  if (relation !== 'descends') {
    return { baseUnreachable: true };
  }
  const [numstat, others, root] = await Promise.all([
    git(
      dir,
      ['diff', ...SAFE_DIFF, IGNORE_SUBMODULE_WORKTREES, '--numstat', sha],
      config,
    ),
    git(
      dir,
      // NUL-separated: a newline-separated listing C-quotes a name holding a tab, a
      // newline or a quote, and the quoted name then names no file.
      ['ls-files', '-z', '--others', '--exclude-standard', '--full-name', ':/'],
      config,
    ),
    git(dir, ['rev-parse', '--show-toplevel'], config),
  ]);
  if (numstat === null || others === null || root === null) {
    return null;
  }

  let added = 0;
  let removed = 0;
  let files = 0;
  let counted = 0;
  for (const line of numstat.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    files += 1;
    // `added<TAB>removed<TAB>path`; a binary file reports `-` for both.
    const [plus, minus] = line.split('\t');
    if (plus === undefined || minus === undefined || plus === '-') {
      continue;
    }
    added += Number(plus);
    removed += Number(minus);
    counted += 1;
  }

  const untracked = others.split('\0').filter((path) => path !== '');
  files += untracked.length;
  const now = limits.now ?? Date.now;
  const deadline = now() + limits.untrackedBudgetMs;
  const lineCounts = await mapLimited(
    untracked.slice(0, limits.maxUntrackedFiles),
    UNTRACKED_READ_CONCURRENCY,
    (path) =>
      untrackedLineCount(
        join(root.trim(), path),
        deadline,
        limits.maxUntrackedFileBytes,
        now,
      ),
  );
  for (const count of lineCounts) {
    if (count !== null) {
      added += count;
      counted += 1;
    }
  }

  // Changes, none of them countable (binary files, say), are not measured rather than +0 −0.
  if (files > 0 && counted === 0) {
    return null;
  }
  return {
    linesAdded: added,
    linesRemoved: removed,
    partial: counted < files,
  };
}
