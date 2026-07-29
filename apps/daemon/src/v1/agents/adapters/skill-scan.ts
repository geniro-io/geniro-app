import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseCommandMd, parseSkillMd } from '../utils/skill-markdown';
import type { AgentSkillEntry } from './adapter.types';

/** Recursion bound for the commands walk (namespaced subdirectories). */
const MAX_COMMAND_DEPTH = 3;

/**
 * The two on-disk SHAPES a CLI agent's invokable set takes — a directory of
 * `<name>/SKILL.md` skills, and a tree of `<name>.md` command files. Both CLIs
 * use the same shapes under different roots (`.claude/skills`,
 * `.claude/commands`, `.cursor/commands`), so the walking lives here while the
 * PATHS stay in each adapter's own subdirectory, where the CLI-specific
 * knowledge belongs.
 *
 * Unreadable or malformed entries are skipped by design (the parse util's
 * tolerance contract): one broken skill file on disk must not fail the list.
 */

/** One skills root: every child directory holding a parseable SKILL.md. */
export async function scanSkillDirs(
  dir: string,
  source: AgentSkillEntry['source'],
): Promise<AgentSkillEntry[]> {
  const out: AgentSkillEntry[] = [];
  for (const entry of await readDirSafe(dir)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const content = await readFileSafe(join(dir, entry.name, 'SKILL.md'));
    if (content === null) {
      continue;
    }
    const meta = parseSkillMd(content, entry.name);
    if (meta !== null) {
      out.push({ ...meta, kind: 'skill', source });
    }
  }
  return out;
}

/** One commands root: every `*.md` file, recursing into subdirectories. */
export async function scanCommandFiles(
  dir: string,
  source: AgentSkillEntry['source'],
  depth = 0,
): Promise<AgentSkillEntry[]> {
  if (depth > MAX_COMMAND_DEPTH) {
    return [];
  }
  const out: AgentSkillEntry[] = [];
  for (const entry of await readDirSafe(dir)) {
    // A symlinked subdirectory reports isDirectory() false — accept it like
    // scanSkillDirs does (users symlink shared command dirs into a project).
    // A symlink to a non-directory is harmless: readDirSafe returns [].
    if (
      entry.isDirectory() ||
      (entry.isSymbolicLink() && !entry.name.endsWith('.md'))
    ) {
      out.push(
        ...(await scanCommandFiles(join(dir, entry.name), source, depth + 1)),
      );
      continue;
    }
    if (!entry.name.endsWith('.md')) {
      continue;
    }
    const content = await readFileSafe(join(dir, entry.name));
    if (content === null) {
      continue;
    }
    const meta = parseCommandMd(content, entry.name.slice(0, -'.md'.length));
    if (meta !== null) {
      out.push({ ...meta, kind: 'command', source });
    }
  }
  return out;
}

/** Directory listing that treats a missing/unreadable dir as empty. */
async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** File read that treats missing/unreadable (e.g. a dir) as absent. */
async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
