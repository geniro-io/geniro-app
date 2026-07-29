import { join } from 'node:path';

import type { AgentSkillEntry, AgentSkillsInput } from '../adapter.types';
import { scanCommandFiles, scanSkillDirs } from '../skill-scan';

/**
 * Where claude keeps what it can be invoked with: skills as
 * `.claude/skills/<dir>/SKILL.md` and commands as `.claude/commands/**.md`,
 * in the project folder and in `~`.
 *
 * The order returned IS the shadowing order the CLI itself applies — project
 * before user, and within one root a skill before a same-named command — so
 * the caller's first-occurrence-wins de-dup reproduces which entry claude
 * would actually run.
 */
export async function scanClaudeSkills({
  cwd,
  homeDir,
}: AgentSkillsInput): Promise<AgentSkillEntry[]> {
  const roots = [
    { source: 'project' as const, dir: cwd },
    { source: 'user' as const, dir: homeDir },
  ];
  const found: AgentSkillEntry[] = [];
  for (const { source, dir } of roots) {
    found.push(
      ...(await scanSkillDirs(join(dir, '.claude', 'skills'), source)),
    );
    found.push(
      ...(await scanCommandFiles(join(dir, '.claude', 'commands'), source)),
    );
  }
  return found;
}
