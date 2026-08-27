import { join } from 'node:path';

import { parseCommandMd, parseSkillMd } from '../../utils/skill-markdown';
import type { AgentSkillEntry } from '../adapter.types';
import { readDirSafe, readFileSafe } from './fs-safe.utils';

/** Recursion bound for the commands walk (namespaced subdirectories). */
const MAX_COMMAND_DEPTH = 3;

/**
 * The two on-disk SHAPES a CLI agent's invokable set takes — a directory of
 * `<name>/SKILL.md` skills, and a tree of `<name>.md` command files. Both CLIs
 * use the same shapes under different roots (`.claude/skills`,
 * `.claude/commands`, `.cursor/commands`), so the walking lives here — read by
 * the base class's `listSkills` — while the PATHS stay in each adapter's own
 * `<name>.const.ts` as `config.skillRoots`, where the CLI-specific knowledge
 * belongs. Nothing in this file may name a CLI or one of its directories.
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

/**
 * Every INSTALLED PLUGIN under one plugin-cache root — discovered, never named.
 *
 * A plugin host keeps its cache as `<root>/<marketplace>/<plugin>/<version>/`,
 * so the three middle segments are whatever the user happens to have installed
 * and cannot be written down anywhere: a caller states the ROOT and the
 * manifest that marks a directory as a plugin, and gets back the version
 * directories that carry one. The manifest check is what keeps this from
 * returning every three-deep directory under the root, and it is the caller's
 * (a CLI reads its own manifest names), so nothing here learns a host's
 * spelling any more than the scanners above learn a CLI's paths.
 *
 * Never throws — a missing cache root is simply a machine with no plugins.
 */
export async function discoverPluginDirs(
  cacheRoot: string,
  manifests: readonly (readonly string[])[],
): Promise<string[]> {
  const out: string[] = [];
  for (const marketplace of await readSubdirs(cacheRoot)) {
    for (const plugin of await readSubdirs(marketplace)) {
      for (const version of await readSubdirs(plugin)) {
        for (const segments of manifests) {
          if ((await readFileSafe(join(version, ...segments))) !== null) {
            out.push(version);
            break;
          }
        }
      }
    }
  }
  return out;
}

/** Child directory PATHS of one dir; missing/unreadable reads as none. */
async function readSubdirs(dir: string): Promise<string[]> {
  return (await readDirSafe(dir))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(dir, entry.name));
}
