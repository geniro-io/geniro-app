import { join } from 'node:path';

import type { NativeMemoryNote } from '../../adapter.types';
import {
  isRealDirectory,
  readRegularFile,
} from '../../utils/regular-file.utils';
import {
  CODEX_MEMORIES_DIR_NAME,
  CODEX_MEMORY_ENTRY_HEADING,
  CODEX_MEMORY_HANDBOOK_FILE,
} from '../codex.const';

/** A handbook larger than this is not read. */
const CODEX_MEMORY_HANDBOOK_MAX_BYTES = 4 * 1024 * 1024;

/** The handbook a codex home keeps its memories in. */
export function codexMemoryHandbookPath(codexHome: string): string {
  return join(codexHome, CODEX_MEMORIES_DIR_NAME, CODEX_MEMORY_HANDBOOK_FILE);
}

/**
 * Every `# Task Group:` block of a codex home's handbook, read only. A missing,
 * symlinked (or under a symlinked `memories`), oversized or unreadable
 * handbook holds no notes: the format is codex's own
 * and undocumented, so nothing here fails the import.
 */
export async function readCodexMemoryNotes(
  codexHome: string,
): Promise<NativeMemoryNote[]> {
  if (!(await isRealDirectory(join(codexHome, CODEX_MEMORIES_DIR_NAME)))) {
    return [];
  }
  const path = codexMemoryHandbookPath(codexHome);
  const text = await readRegularFile(path, CODEX_MEMORY_HANDBOOK_MAX_BYTES);
  return text === null ? [] : parseCodexMemoryHandbook(text, path);
}

/** One note per `# Task Group:` block, its heading the title. */
export function parseCodexMemoryHandbook(
  text: string,
  path: string,
): NativeMemoryNote[] {
  const notes: NativeMemoryNote[] = [];
  let current: { title: string; lines: string[] } | null = null;
  const close = () => {
    if (current) {
      notes.push({
        path,
        importedFrom: `${path} · ${current.title}`,
        projectKey: null,
        folder: null,
        title: current.title,
        body: current.lines.join('\n').trim(),
        type: null,
      });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = CODEX_MEMORY_ENTRY_HEADING.exec(line);
    if (heading) {
      close();
      current = { title: heading[1]!, lines: [] };
    } else {
      current?.lines.push(line);
    }
  }
  close();
  return notes.filter((note) => note.body !== '');
}
