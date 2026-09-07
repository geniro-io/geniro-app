import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { app } from 'electron';

const execFileAsync = promisify(execFile);

/**
 * Config every git call here is made under, ahead of the subcommand.
 *
 * The same list and the same reasoning as `git-info.ts`'s: the repository
 * belongs to the USER, so its own `.git/config` is untrusted input, and
 * `core.fsmonitor` names a program git runs on any command that reads the
 * index. `-c` beats the repository's value and there is no per-invocation
 * opt-out, so refusing it by name is the whole mechanism.
 */
const SAFE_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
];

/** Long enough for a worktree checkout of a large repository. */
const GIT_TIMEOUT_MS = 120_000;

/** One worktree this app created, as the registry records it. */
export interface WorktreeRecord {
  taskId: string;
  path: string;
  branch: string;
  /** The repository the worktree was cut from — what `git worktree` is run in. */
  folder: string;
  createdAt: string;
}

export interface PreparedWorktree {
  path: string;
  branch: string;
}

/**
 * The branch an agent works a task on.
 *
 * Derived from the task's ID rather than its title: a title is the user's own
 * text, so a ref name made from one has to answer for every character git
 * refuses and for two cards that happen to share a title. The id is already
 * unique and already a safe ref.
 */
export function taskBranchName(taskId: string): string {
  return `geniro/task-${taskId}`;
}

function worktreesRoot(): string {
  return join(app.getPath('userData'), 'worktrees');
}

function registryPath(): string {
  return join(app.getPath('userData'), 'worktrees.json');
}

/**
 * Every worktree this app has created and not yet removed.
 *
 * A file rather than memory, for `child-journal.ts`'s reason: a SIGKILLed or
 * force-quit app never runs its cleanup, and the next launch is the only thing
 * left that can. An unreadable or malformed registry reads as EMPTY — the
 * reaper then removes nothing, which is the safe direction, since the only
 * thing the registry authorizes is a delete.
 */
export function readRegistry(): WorktreeRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryPath(), 'utf8'));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((row): row is WorktreeRecord => {
      if (typeof row !== 'object' || row === null) {
        return false;
      }
      const record = row as Partial<WorktreeRecord>;
      return (
        typeof record.taskId === 'string' &&
        typeof record.path === 'string' &&
        typeof record.branch === 'string' &&
        typeof record.folder === 'string'
      );
    });
  } catch {
    return [];
  }
}

function writeRegistry(rows: WorktreeRecord[]): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
  renameSync(tmp, path);
}

function remember(record: WorktreeRecord): void {
  writeRegistry([
    ...readRegistry().filter((row) => row.path !== record.path),
    record,
  ]);
}

function forget(path: string): void {
  writeRegistry(readRegistry().filter((row) => row.path !== path));
}

/**
 * Whether a path sits strictly under the directory this app owns.
 *
 * The registry is a plain JSON file, and it is the ONLY thing that authorizes
 * the recursive delete below — so a row whose `path` names somewhere else,
 * however it came to (a corrupted file, a hand edit, a build with a different
 * layout), would point that delete at whatever it named. Bounding the sink is
 * what makes the delete safe by construction rather than by what the file says.
 *
 * Segment-wise rather than a bare `startsWith`, which would admit a sibling
 * directory whose name merely begins with the root's. The daemon states the
 * same predicate in `v1/agents/utils/path-within.ts`; it is restated here
 * because Electron main imports no daemon source — doing so would pull the
 * Nest graph into the main bundle.
 */
function isInsideWorktreesRoot(path: string): boolean {
  const target = resolve(path);
  // Exactly ONE segment under the root, which is what a legitimate row is:
  // `join(worktreesRoot(), taskId)` where the id is a single path-safe segment
  // (`taskIdSchema`). A prefix test admits `<root>/link/inner`, and `resolve`
  // is purely lexical — so with `<root>/link` a symlink, the recursive delete
  // followed it out of the root and removed the real target. One segment
  // leaves no intermediate component there is anything to symlink.
  return (
    dirname(target) === resolve(worktreesRoot()) && basename(target) !== ''
  );
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', [...SAFE_CONFIG, ...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  });
}

/**
 * Take one worktree down, and stop recording it.
 *
 * `--force` because the agent worked in there: an unmerged branch and a dirty
 * tree are the NORMAL end state of a task run, and a plain remove refuses
 * both. The branch itself is deliberately left behind — it holds the work,
 * which is the entire point of the run.
 *
 * The registry entry is dropped whether or not git succeeded. A path git
 * cannot remove is one this app will never remove either, and keeping the row
 * would make every future reaper pass retry it forever.
 */
export async function removeWorktree(record: WorktreeRecord): Promise<void> {
  if (!isInsideWorktreesRoot(record.path)) {
    // Drop the row so it stops being offered to this function, and delete
    // nothing: a path outside the worktrees directory is not this app's to
    // remove, whatever the registry claims.
    forget(record.path);
    return;
  }
  try {
    // `--` so a path beginning with `-` is a path rather than an option. An
    // argv array stops a shell reading it; it does not stop git doing so.
    await git(record.folder, [
      'worktree',
      'remove',
      '--force',
      '--',
      record.path,
    ]);
  } catch {
    // Fall through to the directory removal below: a worktree whose repository
    // has itself been deleted cannot be removed by git, and the directory is
    // still ours to clear.
  }
  try {
    rmSync(record.path, { recursive: true, force: true });
  } catch {
    // Nothing further to try; the registry entry is dropped either way.
  }
  forget(record.path);
}

/**
 * Whether anything in a worktree is unsaved.
 *
 * Null means UNCONFIRMABLE — git is missing, the directory is not a worktree,
 * the command failed. Every caller reads null as "assume there is work here",
 * because the alternative is deleting on a question nobody could answer.
 */
async function isDirty(path: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...SAFE_CONFIG, 'status', '--porcelain'],
      { cwd: path, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim() !== '';
  } catch {
    return null;
  }
}

/** Whether the repository already holds this task's branch. */
async function branchExists(folder: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      [
        ...SAFE_CONFIG,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ],
      { cwd: folder, timeout: GIT_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Make the worktree and branch a task's agent will work in.
 *
 * Every argument travels as an argv ENTRY rather than inside a shell string,
 * so a folder or branch name cannot become an argument of its own.
 *
 * Two states a second press routinely finds, and neither may destroy work:
 *
 * A LEFTOVER WORKTREE from an earlier run of this same task — the path is per
 * task, so every run of one card wants the same directory. It is cleared only
 * when it holds nothing; one with uncommitted changes refuses the press and
 * says where it is. That is the rule `reapOrphanedWorktrees` already states,
 * and it has to hold here too: a checkout an agent is working in right now
 * looks exactly like a leftover from this side of the boundary, since the
 * claim that knows otherwise lives in the daemon and is consulted after.
 *
 * A LEFTOVER BRANCH with no worktree — the ordinary state after any failed
 * start or any boot reap, because removing a worktree deliberately keeps its
 * branch. `-b` refuses to create a branch that exists, so the branch is
 * re-used rather than re-created when it is already there.
 */
export async function prepareWorktree(input: {
  taskId: string;
  folder: string;
}): Promise<PreparedWorktree> {
  const branch = taskBranchName(input.taskId);
  const path = join(worktreesRoot(), input.taskId);
  mkdirSync(worktreesRoot(), { recursive: true });

  if (existsSync(path)) {
    const dirty = await isDirty(path);
    if (dirty !== false) {
      throw new Error(
        dirty === true
          ? `this task's worktree at ${path} has uncommitted changes — commit or clear them before running it again`
          : `a directory already exists at ${path} and git cannot say what is in it — clear it before running this task again`,
      );
    }
    await removeWorktree(
      readRegistry().find((row) => row.path === path) ?? {
        taskId: input.taskId,
        path,
        branch,
        folder: input.folder,
        createdAt: '',
      },
    );
  }

  await git(
    input.folder,
    (await branchExists(input.folder, branch))
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path],
  );

  remember({
    taskId: input.taskId,
    path,
    branch,
    folder: input.folder,
    createdAt: new Date().toISOString(),
  });
  return { path, branch };
}

/**
 * Whether git agrees this path is a worktree of that repository, and whether
 * anything in it is unsaved.
 *
 * Null means UNCONFIRMABLE — git is missing, the project folder has been
 * deleted or moved, the command failed. The reaper treats that as "leave it
 * alone", never as "it is gone".
 */
async function inspect(
  record: WorktreeRecord,
): Promise<{ registered: boolean; dirty: boolean } | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...SAFE_CONFIG, 'worktree', 'list', '--porcelain'],
      { cwd: record.folder, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const registered = stdout
      .split('\n')
      .some((line) => line.trim() === `worktree ${record.path}`);
    if (!registered) {
      return { registered: false, dirty: false };
    }
    return { registered: true, dirty: (await isDirty(record.path)) !== false };
  } catch {
    return null;
  }
}

/**
 * Clear worktrees a previous launch left behind.
 *
 * Runs at boot, before any task can start, so every entry it sees belongs to a
 * session that has already ended — nothing live can be using one.
 *
 * It mirrors `stranded-child-reaper.service.ts` on the point that matters:
 * it never acts on a recorded entry alone. Each is CONFIRMED against git
 * first, and an entry that cannot be confirmed is left exactly where it is.
 * A worktree holding UNCOMMITTED work is left too, which is the same trade the
 * child reaper makes in the other currency — a surviving stray costs disk,
 * and a mistaken removal costs the user their agent's unsaved work.
 *
 * A path the registry does not name is never touched, whatever is sitting in
 * the worktrees directory.
 */
export async function reapOrphanedWorktrees(): Promise<{
  removed: string[];
  kept: string[];
}> {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const record of readRegistry()) {
    if (!existsSync(record.path)) {
      // Gone from disk already — drop the row so it is not re-examined every
      // launch. Nothing is deleted here.
      forget(record.path);
      removed.push(record.path);
      continue;
    }
    if (!isInsideWorktreesRoot(record.path)) {
      // Refused before `inspect`, which would otherwise run git inside it.
      forget(record.path);
      kept.push(record.path);
      continue;
    }
    const state = await inspect(record);
    // Unconfirmable (no git, the project folder moved), holding unsaved work,
    // or a path git no longer calls a worktree of that repository — all three
    // are left exactly as they are, row included, so a later launch that CAN
    // confirm still gets its chance.
    if (state === null || state.dirty || !state.registered) {
      kept.push(record.path);
      continue;
    }
    await removeWorktree(record);
    removed.push(record.path);
  }
  return { removed, kept };
}

/**
 * Remove the worktree a task was given, if this app made one.
 *
 * Keyed by TASK rather than by path, because that is what a caller knows —
 * and looked up in the registry rather than computed, so a call can only ever
 * reach a path this app recorded creating.
 */
export async function pruneWorktreeForTask(taskId: string): Promise<boolean> {
  const record = readRegistry().find((row) => row.taskId === taskId);
  if (record === undefined) {
    return false;
  }
  // The ROW is refused here rather than at the delete, because everything
  // below RUNS GIT IN the path it names — and a directory this app does not
  // own is not one to run anything in, let alone remove.
  if (!isInsideWorktreesRoot(record.path)) {
    forget(record.path);
    return false;
  }
  // Keeps a worktree holding unsaved work, on `reapOrphanedWorktrees`'s rule
  // and for its reason: this is the FAILED-START path, where the only copy of
  // anything in there would be the user's own. `settleWorktreeForTask` is the
  // one that commits first and therefore may clear a dirty tree.
  if (existsSync(record.path) && (await isDirty(record.path)) !== false) {
    return false;
  }
  await removeWorktree(record);
  return true;
}

/**
 * The subject line of the commit that rescues an agent's unfinished work.
 *
 * CONVENTIONAL, because the repository is the USER's and a `commit-msg` hook
 * running commitlint is ordinary in the repositories this app is pointed at —
 * this one included. A message that cannot be committed is work that cannot be
 * rescued.
 */
function rescueCommitMessage(taskId: string): string {
  return `chore(geniro): unfinished work from task ${taskId}`;
}

/**
 * Commit whatever the agent left uncommitted, onto the branch it worked on.
 *
 * `git add -A` honours the repository's own `.gitignore`, so build output and
 * secrets the user already excludes stay excluded — what lands is the edits.
 *
 * The hooks are RUN rather than skipped. `--no-verify` is refused project-wide
 * and it would be the wrong trade here anyway: a repository whose hooks reject
 * an agent's half-finished tree is one where this returns false and the
 * worktree is KEPT, which is exactly the behaviour that existed before this
 * function and loses nothing. The same is true of a machine with no git
 * identity configured — one is never invented here, since a commit authored as
 * somebody the user did not choose is worse than a directory left on disk.
 */
async function commitUnfinishedWork(
  path: string,
  taskId: string,
): Promise<boolean> {
  try {
    await git(path, ['add', '-A']);
    await git(path, ['commit', '-m', rescueCommitMessage(taskId)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect the worktree of a run that has SETTLED, keeping what is in it.
 *
 * The worktree is per task and the branch is per task, so an agent that
 * finished without committing has left the only copy of its work in a
 * directory nothing else collects — which is why `pruneWorktreeForTask` and
 * the boot reaper both refuse a dirty one, and why, before this, the routine
 * end state of a run was a checkout that stayed on disk for good.
 *
 * Committing first is what makes the removal safe rather than merely bounded:
 * the branch is the whole point of the run and it is never removed with the
 * worktree, so once the work is on it there is nothing left in the directory
 * that the user could not get back.
 *
 * A commit that could not be made is NOT a reason to remove anyway — the
 * worktree is kept and the caller is told which of the two happened.
 */
export async function settleWorktreeForTask(taskId: string): Promise<{
  removed: boolean;
  committed: boolean;
}> {
  const record = readRegistry().find((row) => row.taskId === taskId);
  if (record === undefined) {
    return { removed: false, committed: false };
  }
  // Refused at the LOOKUP, before anything runs git in the path — the same
  // bound, and the same reason, as its sibling above.
  if (!isInsideWorktreesRoot(record.path)) {
    forget(record.path);
    return { removed: false, committed: false };
  }
  if (!existsSync(record.path)) {
    await removeWorktree(record);
    return { removed: true, committed: false };
  }
  const dirty = await isDirty(record.path);
  if (dirty === null) {
    // Unconfirmable — git cannot say what is in there, so neither committing
    // nor removing is a thing to do on a guess.
    return { removed: false, committed: false };
  }
  // A CLEAN tree needs no rescue commit: an empty one would put a commit on
  // every task branch saying nothing happened.
  const committed = dirty
    ? await commitUnfinishedWork(record.path, taskId)
    : false;
  if (dirty && !committed) {
    return { removed: false, committed: false };
  }
  await removeWorktree(record);
  return { removed: true, committed };
}
