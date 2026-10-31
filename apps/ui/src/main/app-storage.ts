import { execFile } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { session } from 'electron';

import type {
  AppStorageEntry,
  AppStorageUsage,
  StorageWorktree,
} from '../shared/contracts';
import { readRegistry, WORKTREES_DIR_NAME } from './worktree-service';

const execFileAsync = promisify(execFile);

/** A full walk of a dozen checkouts with their `node_modules` takes seconds. */
const DU_TIMEOUT_MS = 120_000;

/** Chromium's caches under the profile: rebuilt on demand, never user data. */
export const BROWSER_CACHE_DIRS: readonly string[] = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GraphiteDawnCache',
  'GPUPersistentCache',
];

/** The two of them a running app can empty: `clearCache` and `clearCodeCaches`. */
export const CLEARABLE_BROWSER_CACHE_DIRS: readonly string[] = [
  'Cache',
  'Code Cache',
];

/**
 * Allocated size of each path under `root`, through `du`, so hard links are
 * counted once across every path and symlinks are not followed. A path `du`
 * could not read is answered as 0 rather than failing the scan.
 */
export async function measureWithDu(
  root: string,
  paths: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>(paths.map((path) => [path, 0]));
  if (paths.length === 0) {
    return sizes;
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('/usr/bin/du', ['-sk', '--', ...paths], {
      cwd: root,
      timeout: DU_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? '';
  }
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) {
      continue;
    }
    const kilobytes = Number(line.slice(0, tab));
    const path = line.slice(tab + 1);
    if (sizes.has(path) && Number.isFinite(kilobytes)) {
      sizes.set(path, kilobytes * 1024);
    }
  }
  return sizes;
}

/**
 * The desktop app's share of the data folder: the names the daemon did not
 * claim (`unclaimed`), each sized, the task worktrees one by one.
 */
export async function readAppStorage(
  root: string,
  unclaimed: readonly string[],
  isFinished: (taskIds: string[]) => Promise<ReadonlySet<string> | null>,
): Promise<AppStorageUsage> {
  const present = new Set(readdirSafe(root));
  const names = unclaimed.filter((name) => present.has(name));
  const worktreeNames = names.includes(WORKTREES_DIR_NAME)
    ? readdirSafe(join(root, WORKTREES_DIR_NAME)).filter(
        (name) => name !== '.DS_Store',
      )
    : [];
  const worktreePaths = worktreeNames.map(
    (name) => `${WORKTREES_DIR_NAME}/${name}`,
  );
  const sizes = await measureWithDu(root, [
    ...names.filter((name) => name !== WORKTREES_DIR_NAME),
    ...worktreePaths,
  ]);

  const registry = new Map(
    readRegistry().map((row) => [resolve(row.path), row]),
  );
  const taskIds = [...registry.values()].map((row) => row.taskId);
  const finished =
    taskIds.length === 0 ? new Set<string>() : await isFinished(taskIds);
  const worktrees: StorageWorktree[] = worktreeNames.map((name) => {
    const path = join(root, WORKTREES_DIR_NAME, name);
    const record = registry.get(resolve(path));
    return {
      name,
      bytes: sizes.get(`${WORKTREES_DIR_NAME}/${name}`) ?? 0,
      kind: kindOf(path),
      taskId: record?.taskId ?? null,
      branch: headBranchOf(path) ?? record?.branch ?? null,
      cardFinished:
        record === undefined || finished === null
          ? null
          : finished.has(record.taskId),
    };
  });

  const browserCache: AppStorageEntry[] = [];
  const appData: AppStorageEntry[] = [];
  for (const name of names) {
    if (name === WORKTREES_DIR_NAME) {
      continue;
    }
    const entry = { name, bytes: sizes.get(name) ?? 0 };
    (BROWSER_CACHE_DIRS.includes(name) ? browserCache : appData).push(entry);
  }
  return { worktrees, browserCache, appData };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function kindOf(path: string): StorageWorktree['kind'] {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory()) {
      return 'file';
    }
    return lstatSync(join(path, '.git')).isFile() ? 'worktree' : 'folder';
  } catch {
    return 'folder';
  }
}

/** The branch a linked worktree's HEAD names, read from its own files. */
function headBranchOf(path: string): string | null {
  try {
    const pointer = readFileSync(join(path, '.git'), 'utf8').trim();
    if (!pointer.startsWith('gitdir: ')) {
      return null;
    }
    const head = readFileSync(
      join(pointer.slice('gitdir: '.length), 'HEAD'),
      'utf8',
    ).trim();
    return head.startsWith('ref: refs/heads/')
      ? head.slice('ref: refs/heads/'.length)
      : null;
  } catch {
    return null;
  }
}

/**
 * Empty the window's HTTP cache and compiled-script cache — the two a running
 * app can drop; Chromium refills them as pages load. The GPU caches are in use
 * while a window is open and are left alone.
 */
export async function clearBrowserCache(
  root: string,
): Promise<{ freedBytes: number }> {
  const sum = async (): Promise<number> =>
    [
      ...(await measureWithDu(root, CLEARABLE_BROWSER_CACHE_DIRS)).values(),
    ].reduce((total, bytes) => total + bytes, 0);
  const before = await sum();
  await session.defaultSession.clearCache();
  await session.defaultSession.clearCodeCaches({});
  return { freedBytes: Math.max(0, before - (await sum())) };
}
