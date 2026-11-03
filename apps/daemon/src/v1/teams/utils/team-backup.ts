import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicCreate } from '../../../utils/atomic-file';
import { teamFileHash } from './team-hash';

/** Where backups sit, inside the library — `list()` never reads subfolders. */
export const TEAM_BACKUP_DIR = '.backups';

/** `2026-10-14T21-05-33` — a timestamp a file name can hold. */
function stampOf(at: Date): string {
  return at.toISOString().slice(0, 19).replaceAll(':', '-');
}

/**
 * Write `source` to `<dir>/<baseName>.<timestamp>.yaml`, exclusively, so two
 * copies in one second keep both. Answers the file's name.
 */
export async function backUpFile(
  dir: string,
  baseName: string,
  source: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = stampOf(new Date());
  for (let attempt = 1; ; attempt += 1) {
    const name = `${baseName}.${stamp}${attempt === 1 ? '' : `-${attempt}`}.yaml`;
    try {
      await atomicCreate(join(dir, name), source);
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 50) {
        throw error;
      }
    }
  }
}

/**
 * Copy a team file as it stands to `.backups/<slug>.<timestamp>.yaml` under
 * the library `directory` — never a `*.team.yaml` name, so nothing reads it as
 * a team. Answers the backup's path relative to the library.
 */
export async function backUpTeam(
  directory: string,
  slug: string,
  source: string,
): Promise<string> {
  const name = await backUpFile(join(directory, TEAM_BACKUP_DIR), slug, source);
  return `${TEAM_BACKUP_DIR}/${name}`;
}

/**
 * A library file's text and the hash a save must quote, or null when the file
 * is gone — the read both a save of an analysis and an approved proposal make
 * before backing the file up. Any other failure (a permission, a directory)
 * throws: it is not a deletion, and must not be reported as one.
 */
export async function readTeamSource(
  path: string,
): Promise<{ source: string; hash: string } | null> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return { source, hash: teamFileHash(source) };
}

/**
 * The newest backup of `slug` whose text is `source`, as a path relative to
 * the library, or null — so an agent backing up an unchanged file again gets
 * the copy it already has instead of another full one.
 */
export async function sameBackupOf(
  directory: string,
  slug: string,
  source: string,
): Promise<string | null> {
  const dir = join(directory, TEAM_BACKUP_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const ours = await Promise.all(
    names
      .filter((name) => name.startsWith(`${slug}.`) && name.endsWith('.yaml'))
      .map(async (name) => ({
        name,
        at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0,
      })),
  );
  const newest = ours.sort((a, b) => b.at - a.at)[0];
  if (newest === undefined) {
    return null;
  }
  const text = await readFile(join(dir, newest.name), 'utf8').catch(() => null);
  return text === source ? `${TEAM_BACKUP_DIR}/${newest.name}` : null;
}
