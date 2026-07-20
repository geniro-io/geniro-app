import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentSkillWire } from '../chat.types';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { parseCommandMd, parseSkillMd } from '../utils/skill-markdown';

/** Recursion bound for the commands walk (namespaced subdirectories). */
const MAX_COMMAND_DEPTH = 3;

/** Hard cap on the reply — this feeds a composer popup, not an inventory API. */
const MAX_SKILLS = 200;

interface SkillsServiceOptions {
  /** Test seam — the "user" scan root; defaults to the real home dir. */
  homeDir?: string;
}

/**
 * Discovers the skills / slash commands a CLI agent can be invoked with in a
 * given working directory — the composer's `/` autocomplete. Purely a read of
 * each CLI's own on-disk convention (nothing is registered daemon-side), so
 * the list is exactly what the spawned agent itself would accept:
 * - `claude`: skills (`.claude/skills/<dir>/SKILL.md`) and commands
 *   (`.claude/commands/**.md`), from the project folder and from `~`.
 * - `cursor-agent`: commands (`.cursor/commands/*.md`), project and `~`.
 *
 * Unreadable or malformed entries are skipped by design (the parse util's
 * tolerance contract): one broken skill file on disk must not 500 the list.
 */
@Injectable()
export class SkillsService {
  private readonly homeDir: string;

  constructor(options: SkillsServiceOptions = {}) {
    this.homeDir = options.homeDir ?? homedir();
  }

  async list(agent: AgentKind, cwd: string): Promise<AgentSkillWire[]> {
    const roots = [
      { source: 'project' as const, dir: resolveValidCwd(cwd) },
      { source: 'user' as const, dir: this.homeDir },
    ];
    const found: AgentSkillWire[] = [];
    for (const { source, dir } of roots) {
      if (agent === 'claude') {
        found.push(
          ...(await this.scanSkills(join(dir, '.claude', 'skills'), source)),
        );
        found.push(
          ...(await this.scanCommands(
            join(dir, '.claude', 'commands'),
            source,
          )),
        );
      } else {
        found.push(
          ...(await this.scanCommands(
            join(dir, '.cursor', 'commands'),
            source,
          )),
        );
      }
    }
    // First occurrence wins a name collision — the scan order above makes
    // project shadow user, and a skill shadow a same-named command within one
    // source (matching which one the CLI would actually run).
    const byName = new Map<string, AgentSkillWire>();
    for (const skill of found) {
      if (!byName.has(skill.name)) {
        byName.set(skill.name, skill);
      }
    }
    return [...byName.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_SKILLS);
  }

  /** One skills root: every child directory holding a parseable SKILL.md. */
  private async scanSkills(
    dir: string,
    source: AgentSkillWire['source'],
  ): Promise<AgentSkillWire[]> {
    const out: AgentSkillWire[] = [];
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
  private async scanCommands(
    dir: string,
    source: AgentSkillWire['source'],
    depth = 0,
  ): Promise<AgentSkillWire[]> {
    if (depth > MAX_COMMAND_DEPTH) {
      return [];
    }
    const out: AgentSkillWire[] = [];
    for (const entry of await readDirSafe(dir)) {
      if (entry.isDirectory()) {
        out.push(
          ...(await this.scanCommands(
            join(dir, entry.name),
            source,
            depth + 1,
          )),
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
