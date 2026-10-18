import { execFile } from 'node:child_process';
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { chmod, copyFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';

import { SAFE_CONFIG } from './git-safe-config';

const execFileAsync = promisify(execFile);

/**
 * The repository-root file whose gitignore-style patterns name the local files
 * a new task worktree should start with — the `.worktreeinclude` Claude Code's
 * own `--worktree` sessions read.
 */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** Where {@link copyWorktreeIncludeFiles} says what it did and what it skipped. */
export type WorktreeLog = (level: 'info' | 'warn', message: string) => void;

const STEP_TIMEOUT_MS = 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The checkout's top level, since a card's folder may be a subfolder of it. */
async function checkoutRoot(folder: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...SAFE_CONFIG, 'rev-parse', '--show-toplevel'],
      { cwd: folder, timeout: STEP_TIMEOUT_MS },
    );
    const root = stdout.trim();
    return root === '' ? null : root;
  } catch {
    return null;
  }
}

/**
 * The paths among `paths` that the checkout's own ignore rules ignore, asked
 * of one `git check-ignore` over stdin (NUL-separated both ways, so no path is
 * ever quoted or split).
 *
 * It exits 1 when it ignores none of them, which is an answer rather than a
 * failure; any other failure rejects, and the caller copies nothing.
 */
function ignoredAmong(
  root: string,
  paths: readonly string[],
): Promise<Set<string>> {
  if (paths.length === 0) {
    return Promise.resolve(new Set());
  }
  return new Promise((resolvePaths, reject) => {
    const child = execFile(
      'git',
      [...SAFE_CONFIG, 'check-ignore', '--stdin', '-z'],
      { cwd: root, timeout: STEP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null && error.code !== 1) {
          reject(error);
          return;
        }
        resolvePaths(
          new Set(
            (error === null ? stdout : '')
              .split('\0')
              .filter((path) => path !== ''),
          ),
        );
      },
    );
    // A git that exits before reading all of stdin (the timeout, say) makes
    // this write fail with EPIPE. The callback above already reports that
    // failure; unlistened, the stream's own error would be uncaught in main.
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${paths.join('\0')}\0`);
  });
}

/**
 * The untracked files `.worktreeinclude`'s patterns match, kept only where the
 * checkout's `.gitignore` also ignores them.
 *
 * Both, as in Claude Code: the include file says which local files are WANTED,
 * and the ignore rules are what make a file local. A tracked file reaches the
 * worktree through git already, and an untracked one that is not ignored is
 * work in progress, not config — neither is copied.
 */
async function listWorktreeIncludePaths(
  root: string,
  includePath: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    [
      ...SAFE_CONFIG,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-from',
      includePath,
      '-z',
    ],
    { cwd: root, timeout: STEP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
  );
  const matched = stdout.split('\0').filter((path) => path !== '');
  const ignored = await ignoredAmong(root, matched);
  return matched.filter((path) => ignored.has(path));
}

/**
 * Whether `dir` resolves inside `worktreeReal` — judged on its nearest folder
 * that exists, so a folder about to be made is judged by where it would land.
 */
function landsInWorktree(worktreeReal: string, dir: string): boolean {
  let existing = dir;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      return false;
    }
    existing = parent;
  }
  const real = realpathSync(existing);
  return real === worktreeReal || real.startsWith(`${worktreeReal}${sep}`);
}

/**
 * Copy one file, never over one already there and never through a symlink:
 * a link's target may sit anywhere on the disk, and only the checkout's own
 * files are the user's to hand to the worktree.
 *
 * That holds on BOTH sides. The source is checked with `lstat`. The target's
 * folder is checked before it is made and again after: a reused task branch
 * can carry a committed symlink (`config -> /elsewhere`), and writing
 * `config/.env` through it would put the file outside the worktree.
 */
async function copyOneFile(
  source: string,
  target: string,
  worktreeReal: string,
): Promise<'copied' | 'skipped' | 'escaped' | 'failed'> {
  try {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile() || existsSync(target)) {
      return 'skipped';
    }
    const folder = dirname(target);
    if (!landsInWorktree(worktreeReal, folder)) {
      return 'escaped';
    }
    mkdirSync(folder, { recursive: true });
    if (!landsInWorktree(worktreeReal, folder)) {
      return 'escaped';
    }
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await chmod(target, stat.mode & 0o777);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/**
 * Copy the gitignored files the source checkout's `.worktreeinclude` lists
 * into a worktree just created — a `.env`, a toolchain pin, an editor's local
 * settings — so the agent working there starts with what a checkout of the
 * same repository would have.
 *
 * Only on the user's say-so: a repository without the file gets nothing, and
 * nothing is kept anywhere but in the new worktree.
 *
 * Never throws. A worktree without its local files is still a worktree, so
 * every failure is logged and the start goes on.
 */
export async function copyWorktreeIncludeFiles(input: {
  /** Any directory of the source checkout; the card's folder may be a subfolder. */
  folder: string;
  worktree: string;
  log: WorktreeLog;
}): Promise<void> {
  const root = await checkoutRoot(input.folder);
  if (root === null) {
    input.log(
      'warn',
      `worktree include not copied into ${input.worktree}: git could not name the checkout root of ${input.folder}`,
    );
    return;
  }

  const includePath = join(root, WORKTREE_INCLUDE_FILE);
  if (!existsSync(includePath)) {
    return;
  }

  let paths: string[];
  try {
    paths = await listWorktreeIncludePaths(root, includePath);
  } catch (error) {
    input.log(
      'warn',
      `worktree include not copied into ${input.worktree}: git could not list the ignored files ${WORKTREE_INCLUDE_FILE} matches (${errorText(error)})`,
    );
    return;
  }

  let worktreeReal: string;
  try {
    worktreeReal = realpathSync(input.worktree);
  } catch (error) {
    input.log(
      'warn',
      `worktree include not copied into ${input.worktree}: ${errorText(error)}`,
    );
    return;
  }

  const copied: string[] = [];
  for (const relative of paths) {
    // `relative` is git's own listing of files under `root`, so it never
    // climbs out of the source checkout: git does not walk through a
    // symlinked folder, and `copyOneFile` refuses a symlinked file. The
    // worktree side is `copyOneFile`'s to check.
    const outcome = await copyOneFile(
      join(root, relative),
      join(input.worktree, relative),
      worktreeReal,
    );
    if (outcome === 'copied') {
      copied.push(relative);
    } else if (outcome === 'escaped') {
      input.log(
        'warn',
        `worktree include skipped ${relative}: a folder on its path in ${input.worktree} is a symlink that leads out of the worktree`,
      );
    } else if (outcome === 'failed') {
      input.log(
        'warn',
        `worktree include could not copy ${relative} into ${input.worktree}`,
      );
    }
  }

  if (copied.length > 0) {
    input.log(
      'info',
      `worktree include copied ${copied.length} file(s) into ${input.worktree}: ${copied.join(', ')}`,
    );
  }
}
