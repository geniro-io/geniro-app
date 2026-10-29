import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { splitFrontmatter } from '../../../utils/skill-markdown';
import type { NativeMemoryNote } from '../../adapter.types';
import {
  isRealDirectory,
  readRegularFile,
} from '../../utils/regular-file.utils';
import {
  CLAUDE_MEMORY_DIR_NAME,
  CLAUDE_MEMORY_INDEX_FILE,
  CLAUDE_SESSIONS_DIR_NAME,
} from '../claude.const';

/** A note file larger than this is not a note; it is skipped unread. */
const CLAUDE_MEMORY_FILE_MAX_BYTES = 256 * 1024;

/**
 * Every memory note one profile keeps, read only: each project directory's
 * `memory/*.md` but its `MEMORY.md` index. No symlinked directory on the way
 * nor a symlinked or hard-linked note is followed (`readRegularFile`), and a
 * directory that cannot be read is skipped.
 */
export async function readClaudeMemoryNotes(
  configDir: string,
): Promise<NativeMemoryNote[]> {
  const projectsDir = join(configDir, CLAUDE_SESSIONS_DIR_NAME);
  const notes: NativeMemoryNote[] = [];
  if (!(await isRealDirectory(projectsDir))) {
    return notes;
  }
  for (const project of await directoryEntries(projectsDir)) {
    if (!project.isDirectory()) {
      continue;
    }
    const memoryDir = join(projectsDir, project.name, CLAUDE_MEMORY_DIR_NAME);
    if (!(await isRealDirectory(memoryDir))) {
      continue;
    }
    for (const file of await directoryEntries(memoryDir)) {
      if (
        !file.isFile() ||
        !file.name.endsWith('.md') ||
        file.name === CLAUDE_MEMORY_INDEX_FILE
      ) {
        continue;
      }
      const path = join(memoryDir, file.name);
      const text = await readRegularFile(path, CLAUDE_MEMORY_FILE_MAX_BYTES);
      if (text !== null) {
        notes.push({
          path,
          importedFrom: path,
          projectKey: project.name,
          ...parseClaudeMemoryNote(text, path),
        });
      }
    }
  }
  return notes;
}

/**
 * A note's title is its frontmatter `name` (else the file name), its body the
 * `description` line followed by the text, and its type the top-level `type`,
 * else `metadata.type`.
 */
export function parseClaudeMemoryNote(
  text: string,
  path: string,
): Pick<NativeMemoryNote, 'title' | 'body' | 'type'> {
  const { frontmatter, body } = splitFrontmatter(text);
  const metadata = frontmatter['metadata'];
  const nested =
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const description = line(frontmatter['description']);
  const rest = body.trim();
  return {
    title: line(frontmatter['name']) ?? basename(path, '.md'),
    body: [description, rest].filter(Boolean).join('\n\n'),
    type: line(frontmatter['type']) ?? line(nested['type']),
  };
}

function line(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

async function directoryEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
