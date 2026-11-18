import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, normalize, relative } from 'node:path';

import { repositoryRootOf } from './repository-root';
import { existingDirectory } from './resolve-directory';

/** Whether a run's folder is gone from disk — the one case a turn moves for. */
export function isFolderGone(cwd: string): boolean {
  return isAbsolute(cwd) && !existsSync(cwd);
}

/** What a run knows about where its deleted folder came from. */
export interface MovedFolderSources {
  /** The folder its worktree was cut from: a card's folder, or a repository. */
  source: string | null;
  project: string | null;
  /** Geniro's data folder, which a turn never runs in nor above. */
  userDataDir: string;
}

/**
 * Where a turn runs once its folder `gone` was deleted: the first existing one
 * of the folder its worktree was cut from, the repository root above it and
 * the run's project folder — or null when none of them may take it. A move
 * widens what an agent may edit unasked, so the home folder, `/`, `/Volumes`
 * and any folder holding or inside Geniro's data folder never take one (user
 * decision: only the work's own source).
 */
export async function movedFolderOf(
  gone: string,
  sources: MovedFolderSources,
): Promise<string | null> {
  const origin = normalize(gone);
  const repository = await repositoryRootOf(origin);
  const unsafe = unsafeFolders(sources.userDataDir);
  for (const candidate of [sources.source, repository, sources.project]) {
    if (candidate === null || normalize(candidate) === origin) {
      continue;
    }
    const folder = existingDirectory(candidate);
    if (folder !== null && !unsafe(folder)) {
      return folder;
    }
  }
  return null;
}

/** The transcript line and the prompt line for a run moved out of `gone`. */
export function movedFolderNote(
  gone: string,
  folder: string,
): { transcript: string; prompt: string } {
  return {
    transcript: `The folder ${gone} no longer exists, so this thread now works in ${folder}.`,
    prompt: `Your working folder ${JSON.stringify(gone)} was deleted. From this turn on you work in ${JSON.stringify(folder)}; paths under the old folder no longer exist.`,
  };
}

function unsafeFolders(userDataDir: string): (folder: string) => boolean {
  const data = [userDataDir, existingDirectory(userDataDir) ?? userDataDir];
  const home = [homedir(), existingDirectory(homedir()) ?? homedir()];
  const exact = new Set(
    [...home, '/', '/Volumes'].map((path) => normalize(path)),
  );
  return (folder) =>
    exact.has(normalize(folder)) ||
    data.some((root) => isInside(folder, root) || isInside(root, folder));
}

function isInside(path: string, root: string): boolean {
  const rel = relative(normalize(root), normalize(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
