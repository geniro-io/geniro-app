import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
  /**
   * True when this was the task's own worktree, already standing, handed back
   * as it was — see `prepareWorktree`, and why a refused start must then leave
   * it alone.
   */
  reused: boolean;
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
 * Whether git lists `path` as a worktree of `folder` with `branch` checked out
 * — this task's OWN worktree, as opposed to something else sitting in its slot.
 *
 * False on any failure, which sends the caller down the path that refuses a
 * directory it cannot account for rather than the one that continues in it.
 */
async function holdsBranch(
  folder: string,
  path: string,
  branch: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...SAFE_CONFIG, 'worktree', 'list', '--porcelain'],
      { cwd: folder, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    // One block per worktree, separated by a blank line — so the path and the
    // branch have to be read off the SAME block, or a stray branch line from a
    // neighbour would vouch for this path.
    return stdout.split(/\n\s*\n/).some((block) => {
      const lines = block.split('\n').map((line) => line.trim());
      return (
        lines.includes(`worktree ${path}`) &&
        lines.includes(`branch refs/heads/${branch}`)
      );
    });
  } catch {
    return false;
  }
}

/**
 * Make the worktree and branch a task's agent will work in — or hand back the
 * one this task already has.
 *
 * Every argument travels as an argv ENTRY rather than inside a shell string,
 * so a folder or branch name cannot become an argument of its own.
 *
 * Three states a press routinely finds, and none may destroy work:
 *
 * THIS TASK'S OWN WORKTREE, still standing — the ordinary state since a
 * worktree lives until its card's work is finished (`settleWorktreeForTask`):
 * a card Stop sent back to To do, one whose run failed, one pressed again from
 * review. It is CONTINUED as it stands, uncommitted work included, because that
 * work is this task's and the run being started is its next step — refusing it
 * would turn every re-run of a card whose agent had not committed into "commit
 * or clear them" first. `reused` says so, and a caller whose start is then
 * refused must NOT give it back: another run of this same task may be the
 * reason for the refusal, and be working in it.
 *
 * ANYTHING ELSE in that slot — a directory git does not call this task's, or
 * one somebody made by hand. An EMPTY one is cleared, there being nothing in it
 * to lose. Otherwise it is cleared only when git says it holds nothing; one
 * with uncommitted changes, or one git cannot answer for, refuses the press
 * and says where it is.
 *
 * A LEFTOVER BRANCH with no worktree — the ordinary state once a card's work
 * has been collected, because removing a worktree deliberately keeps its
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
  const existing = readRegistry().find((row) => row.path === path);

  if (existsSync(path)) {
    if (await holdsBranch(input.folder, path, branch)) {
      remember({
        taskId: input.taskId,
        path,
        branch,
        folder: input.folder,
        createdAt:
          existing !== undefined && existing.createdAt !== ''
            ? existing.createdAt
            : new Date().toISOString(),
      });
      return { path, branch, reused: true };
    }
    if (readdirSync(path).length === 0) {
      rmSync(path, { recursive: true, force: true });
    } else {
      const dirty = await isDirty(path);
      if (dirty !== false) {
        throw new Error(
          dirty === true
            ? `this task's worktree at ${path} has uncommitted changes — commit or clear them before running it again`
            : `a directory already exists at ${path} and git cannot say what is in it — clear it before running this task again`,
        );
      }
      await removeWorktree(
        existing ?? {
          taskId: input.taskId,
          path,
          branch,
          folder: input.folder,
          createdAt: '',
        },
      );
    }
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
  return { path, branch, reused: false };
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
 * Collect the worktrees whose card's work is FINISHED, and nothing else.
 *
 * A worktree lives until its card is Done (see `settleWorktreeForTask`), so
 * most of what the registry holds at any moment is LIVE — a card in review
 * whose conversation the user will carry on. This used to remove every clean
 * entry at launch, on the reading that anything still registered was a
 * leftover; that reading ended with collect-on-settle, and kept, it would take
 * the cwd out from under every reviewed conversation at the next restart.
 *
 * Which cards are finished is the DAEMON's answer (`isFinished`), because both
 * facts it takes — the card's column, and whether its run is still working —
 * are rows this process cannot read. It catches what the board's own
 * collection misses: a run that settled under a Done card while no window was
 * open, and a deleted card whose worktree the prune kept because it held work.
 * An answer that could not be had collects NOTHING — a stray costs disk, a
 * guess costs the user their agent's work.
 *
 * It still never acts on a recorded entry alone, mirroring
 * `stranded-child-reaper.service.ts`: each is CONFIRMED against git first, and
 * one that cannot be confirmed is left exactly where it is. The removal itself
 * is `settleWorktreeForTask`'s, so unsaved work is committed onto the task's
 * branch first and a worktree whose commit is refused stays. A path the
 * registry does not name is never touched.
 */
export async function reapFinishedWorktrees(
  isFinished: (taskIds: string[]) => Promise<ReadonlySet<string> | null>,
): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  const standing: WorktreeRecord[] = [];
  for (const record of readRegistry()) {
    if (!existsSync(record.path)) {
      // Gone from disk already — drop the row so it is not re-examined on
      // every pass. Nothing is deleted here.
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
    standing.push(record);
  }
  if (standing.length === 0) {
    return { removed, kept };
  }
  const finished = await isFinished(
    standing.map((record) => record.taskId),
  ).catch(() => null);
  for (const record of standing) {
    if (finished === null || !finished.has(record.taskId)) {
      kept.push(record.path);
      continue;
    }
    const state = await inspect(record);
    // Unconfirmable (no git, the project folder moved), or a path git no
    // longer calls a worktree of that repository — left exactly as they are,
    // row included, so a later pass that CAN confirm still gets its chance.
    if (state === null || !state.registered) {
      kept.push(record.path);
      continue;
    }
    const outcome = await settleWorktreeForTask(record.taskId);
    (outcome.removed ? removed : kept).push(record.path);
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
  // Keeps a worktree holding unsaved work: this is the FAILED-START and the
  // card-delete path, where nothing has said the work is finished and the only
  // copy of anything in there may be the agent's. `settleWorktreeForTask` is
  // the one that commits first and therefore may clear a dirty tree.
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
 * Collect the worktree of a card whose work is FINISHED, keeping what git can.
 *
 * Finished means the card is Done and no run is working in it — the daemon's
 * `isWorkFinished`, reached through the board's `work-finished` event and
 * through `reapFinishedWorktrees`. This used to run the moment a run SETTLED,
 * which was the wrong moment: a task's run is a chat the user continues after
 * review, and the CLI opens a turn of its own when a background command it
 * started reports back — so the directory went out from under a live
 * conversation (its next turn failed in 0ms, every message after it on `cwd
 * does not exist`), and took with it what no commit holds.
 *
 * The worktree is per task and the branch is per task, so an agent that
 * finished without committing has left the only copy of its work in a
 * directory nothing else collects — which is why `pruneWorktreeForTask`
 * refuses a dirty one, and why this commits before it removes. The branch is
 * never removed with the worktree, so once the work is on it every TRACKED
 * change can be got back. What `.gitignore` excludes cannot — an agent's
 * screenshots, its build output — and that is why the collection waits for
 * the user to call the card Done rather than for the agent to stop talking.
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
