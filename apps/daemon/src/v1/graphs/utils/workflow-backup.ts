import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicCreate } from '../../../utils/atomic-file';
import { workflowFileHash } from './workflow-hash';

/** Where backups sit, inside the library — `list()` never reads subfolders. */
export const WORKFLOW_BACKUP_DIR = '.backups';

/** `2026-10-14T21-05-33` — a timestamp a file name can hold. */
function stampOf(at: Date): string {
  return at.toISOString().slice(0, 19).replaceAll(':', '-');
}

/**
 * Copy a workflow file as it stands to `.backups/<slug>.<timestamp>.yaml` under
 * the library `directory` — never a `*.geniro.yaml` name, so nothing reads it as
 * a workflow. Exclusive, so two saves in one second keep both copies. Answers
 * the backup's path relative to the library.
 */
export async function backUpWorkflow(
  directory: string,
  slug: string,
  source: string,
): Promise<string> {
  const dir = join(directory, WORKFLOW_BACKUP_DIR);
  await mkdir(dir, { recursive: true });
  const stamp = stampOf(new Date());
  for (let attempt = 1; ; attempt += 1) {
    const name = `${slug}.${stamp}${attempt === 1 ? '' : `-${attempt}`}.yaml`;
    try {
      await atomicCreate(join(dir, name), source);
      return `${WORKFLOW_BACKUP_DIR}/${name}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 50) {
        throw error;
      }
    }
  }
}

/**
 * A library file's text and the hash a save must quote, or null when the file
 * is gone — the read both a save of an analysis and an approved proposal make
 * before backing the file up. Any other failure (a permission, a directory)
 * throws: it is not a deletion, and must not be reported as one.
 */
export async function readWorkflowSource(
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
  return { source, hash: workflowFileHash(source) };
}
