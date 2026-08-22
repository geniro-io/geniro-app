import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  BranchPullResult,
  BranchSwitchResult,
  BranchWorktree,
  GitInfo,
} from '../shared/contracts';

const execFileAsync = promisify(execFile);

/** No git call may hang the composer's chip render. */
const GIT_TIMEOUT_MS = 5000;

/**
 * A pull talks to a remote, so it gets its own budget: five seconds is a
 * generous limit on reading a local ref and a mean one on a fetch over a slow
 * link, and a pull cut off mid-transfer for want of a few seconds is a failure
 * the user reads as a bug.
 */
const GIT_PULL_TIMEOUT_MS = 60_000;

const NOT_A_REPO: GitInfo = {
  isRepo: false,
  branch: null,
  branches: [],
  dirty: false,
  worktrees: [],
};

/**
 * Run one git command in `cwd`. Never throws: a missing binary, a non-repo
 * directory and a failed subcommand are all "no answer" to a caller that only
 * wants to decide whether to show a chip.
 */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      // A repo with thousands of branches must not blow up the IPC payload.
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Which branches OTHER worktrees of this repo hold, and where.
 *
 * The porcelain form is parsed rather than the human one for the reason every
 * other git read here gives: `--porcelain` is a documented, locale-independent
 * format, while the plain listing pads columns and abbreviates. Records come as
 * blank-line-separated blocks of `worktree <path>` / `HEAD <sha>` / `branch
 * <ref>`, with `detached` or `bare` in place of the branch line where there is
 * none.
 *
 * `self` — this folder's own worktree root — is dropped: the branch it holds is
 * the one already checked out here, and calling that "held elsewhere" would put
 * the current branch behind a refusal.
 */
async function readWorktrees(
  dir: string,
  self: string | null,
): Promise<BranchWorktree[]> {
  const listing = await git(dir, ['worktree', 'list', '--porcelain']);
  if (listing === null) {
    return [];
  }
  const found: BranchWorktree[] = [];
  let path: string | null = null;
  for (const line of listing.split('\n')) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length).trim();
      continue;
    }
    if (line.startsWith('branch ') && path !== null) {
      const branch = line.slice('branch '.length).trim();
      if (path !== self && branch.startsWith('refs/heads/')) {
        found.push({
          branch: branch.slice('refs/heads/'.length),
          path,
        });
      }
    }
  }
  return found;
}

/**
 * Describe the git state of a folder for the composer's branch chip.
 *
 * A detached HEAD reports `branch: null` — there is no branch to name, and
 * claiming one ("HEAD") would put a bogus entry in the picker.
 */
export async function readGitInfo(dir: string): Promise<GitInfo> {
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return NOT_A_REPO;
  }
  const [head, refs, status, root] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    git(dir, ['status', '--porcelain']),
    // The worktree ROOT, not `dir`: a run's folder is routinely a subdirectory
    // of the checkout, and comparing that against the paths `worktree list`
    // prints would match none of them — leaving this folder's own branch listed
    // as held somewhere else, and unswitchable-to for good.
    git(dir, ['rev-parse', '--show-toplevel']),
  ]);
  return {
    isRepo: true,
    branch: head === null || head === 'HEAD' ? null : head,
    branches: refs === null || refs === '' ? [] : refs.split('\n'),
    // `null` = the status call itself failed; treating that as clean would let
    // a checkout run without the guard ever having looked.
    dirty: status === null || status !== '',
    worktrees: await readWorktrees(dir, root),
  };
}

/**
 * Switch `dir` to `branch`, but never over uncommitted work.
 *
 * The dirty check is re-run here rather than trusted from the renderer's last
 * {@link readGitInfo}: that snapshot can be seconds old, and the whole point of
 * the guard is that the tree may have changed since the chip was drawn.
 */
export async function switchBranch(
  dir: string,
  branch: string,
): Promise<BranchSwitchResult> {
  const info = await readGitInfo(dir);
  if (!info.isRepo) {
    return {
      ok: false,
      branch: null,
      error: 'Not a git repository',
      dirty: false,
      worktree: null,
    };
  }
  if (info.branch === branch) {
    return { ok: true, branch, error: null, dirty: false, worktree: null };
  }
  // BEFORE the dirty guard, because it outranks it: git will not check a branch
  // out into two worktrees however clean the tree is, so committing or pulling
  // changes nothing here — and offering Pull, which the dirty refusal does,
  // would be a control that has no way to help.
  //
  // Decided from the worktree LISTING rather than from git's `fatal: '<branch>'
  // is already used by worktree at …`, which is prose: it is translated under a
  // non-English locale, and matching it is how a refusal silently degrades into
  // "git switch failed" on someone else's machine.
  const held = info.worktrees.find((entry) => entry.branch === branch);
  if (held) {
    return {
      ok: false,
      branch: info.branch,
      error: `${branch} is checked out in another worktree — this folder stays on ${info.branch ?? 'a detached HEAD'}`,
      dirty: false,
      worktree: held.path,
    };
  }
  if (info.dirty) {
    return {
      ok: false,
      branch: info.branch,
      // No longer an instruction ("commit or stash them first"): the app can
      // now do the useful half itself, so the sentence states the situation and
      // the button beside it offers the way out.
      error: 'Uncommitted changes in this folder — the branch stays put',
      dirty: true,
      worktree: null,
    };
  }
  try {
    // `switch`, never `checkout`: checkout resolves its argument as a branch OR
    // a pathspec, so in a repo holding a file named like the branch it would
    // RESTORE THAT FILE instead of switching — silently discarding edits. And
    // `git checkout -- <name>` is unambiguously the file form, not the branch
    // form. `switch` only ever means a branch. execFile takes an argv array, so
    // there is no shell to inject into either.
    await execFileAsync('git', ['switch', branch], {
      cwd: dir,
      timeout: GIT_TIMEOUT_MS,
    });
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : '';
    return {
      ok: false,
      branch: info.branch,
      error: stderr === '' ? 'git switch failed' : stderr.split('\n')[0]!,
      dirty: false,
      worktree: null,
    };
  }
  return { ok: true, branch, error: null, dirty: false, worktree: null };
}

/**
 * The stash this makes, named so the user can find it if it has to be left
 * behind. `git stash pop` keeps the entry when applying it conflicts, which is
 * the one path where the message has to point somewhere.
 */
const PULL_STASH_MESSAGE = 'geniro: pull';

/**
 * Whether the current stash tip is the one THIS pull just pushed, not a
 * concurrent write from elsewhere.
 *
 * git prefixes every `--message` with `On <branch>: `, so the tip's subject
 * is never exactly {@link PULL_STASH_MESSAGE} — only ends with it.
 *
 * BOTH signals are required, and neither is sufficient alone. The subject alone
 * matches a LEFTOVER entry from an earlier run whose pop conflicted (the
 * documented `stashLeft` state) — and `git stash push` on a tree that is not
 * really dirty exits 0 having created nothing, which is reachable because
 * `readGitInfo` reports a FAILED `git status` as dirty. The ref alone matches a
 * concurrent `git stash` from the user's own terminal. Popping on either
 * mistake applies work this pull never moved.
 */
async function stashTipOid(dir: string): Promise<string | null> {
  return git(dir, ['rev-parse', '-q', '--verify', 'refs/stash']);
}

async function stashTipSubject(dir: string): Promise<string | null> {
  return git(dir, ['log', '-1', '--format=%s', 'refs/stash']);
}

/**
 * The ownership decision itself, separated from the three git reads that feed
 * it so both halves of the AND can be entered by a test — the reachable
 * mistakes need a `git status` failure to reproduce end to end, which a
 * real-repo spec cannot force.
 */
export function pullStashIsOurs(
  before: string | null,
  after: string | null,
  subject: string | null,
): boolean {
  return (
    after !== null &&
    after !== before &&
    subject !== null &&
    subject.endsWith(PULL_STASH_MESSAGE)
  );
}

/**
 * Bring the folder's branch up to date WITHOUT losing uncommitted work:
 * stash → `git pull --ff-only` → put the stash back.
 *
 * **`--ff-only`, deliberately.** A fast-forward is the only pull that cannot
 * leave a repository in a state the user then has to resolve — no merge commit
 * they did not ask for, no half-finished rebase, no conflict in a tree they were
 * not looking at. A diverged branch is refused with git's own sentence, which is
 * the honest answer: what to do about a divergence is not a decision a button in
 * a chat composer gets to take.
 *
 * **The stash is put back on EVERY path, including a failed pull.** Hiding the
 * user's work and then failing before restoring it is the one outcome this must
 * never produce — it looks exactly like the edits were destroyed. When the pop
 * itself conflicts git keeps the entry, and {@link BranchPullResult.stashLeft}
 * says where it is rather than leaving the user to guess.
 *
 * **The push runs on the pull's own budget, not the chip-read one**, and its
 * result is checked rather than discarded: a large tree's stash push can
 * outrun the chip-read timeout and be cut off mid-operation with the failure
 * invisible, after which a pull would run against a still-dirty tree with no
 * protection. A failed push aborts the pull rather than proceeding.
 *
 * Whether anything was stashed — and so needs popping back — is decided by the
 * new stash tip's own message AND its ref moving (see {@link pullStashIsOurs}),
 * not merely by the
 * stash ref having moved: the ref moving is also what a concurrent
 * `git stash` from somewhere else looks like, and popping that entry into the
 * tree is not this pull's business.
 */
export async function pullBranch(dir: string): Promise<BranchPullResult> {
  const info = await readGitInfo(dir);
  if (!info.isRepo) {
    return {
      ok: false,
      branch: null,
      error: 'Not a git repository',
      stashLeft: null,
    };
  }
  if (info.branch === null) {
    // A detached HEAD has no upstream to pull from, and `git pull` there would
    // be a question about which ref — one this has no business guessing at.
    return {
      ok: false,
      branch: null,
      error: 'Detached HEAD — check out a branch first',
      stashLeft: null,
    };
  }
  const branch = info.branch;
  let stashed = false;
  const stashBefore = info.dirty ? await stashTipOid(dir) : null;
  if (info.dirty) {
    // `--include-untracked`, because a new file the user has not added yet is
    // work in exactly the same sense as an edit to a tracked one, and a pull
    // that fast-forwards a file into that path fails on it.
    const push = await runGit(dir, [
      'stash',
      'push',
      '--include-untracked',
      '--message',
      PULL_STASH_MESSAGE,
    ]);
    if (push !== true) {
      // The tree is exactly as dirty as it was — nothing was moved aside, so
      // there is nothing to leave stashed, and a pull now would run against
      // uncommitted work with no protection.
      return { ok: false, branch, error: push, stashLeft: null };
    }
    stashed = pullStashIsOurs(
      stashBefore,
      await stashTipOid(dir),
      await stashTipSubject(dir),
    );
  }
  const pull = await runGit(dir, ['pull', '--ff-only']);
  const restore = stashed ? await runGit(dir, ['stash', 'pop']) : null;
  const stashLeft = restore !== null && restore !== true ? 'stash@{0}' : null;
  if (pull !== true) {
    return {
      ok: false,
      branch,
      error: pull,
      stashLeft,
    };
  }
  if (stashLeft !== null) {
    return {
      ok: false,
      branch,
      // The pull SUCCEEDED and the restore did not, which is a different thing
      // to report: the branch moved, the work is safe, and it is sitting in a
      // stash the user has to apply by hand.
      error: `Pulled, but your changes could not be restored — they are kept in ${stashLeft}`,
      stashLeft,
    };
  }
  return { ok: true, branch, error: null, stashLeft: null };
}

/**
 * Run one git command for its OUTCOME: `true`, or git's own first line of
 * stderr.
 *
 * Separate from {@link git}, which answers with stdout and swallows the reason
 * — right for reading state, useless for an action whose whole value on failure
 * is git's explanation of what it refused and why.
 */
async function runGit(dir: string, args: string[]): Promise<true | string> {
  try {
    await execFileAsync('git', args, {
      cwd: dir,
      timeout: GIT_PULL_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : '';
    return stderr === ''
      ? `git ${args[0]} failed`
      : (stderr.split('\n').find((line) => line.trim() !== '') ?? 'git failed');
  }
}
