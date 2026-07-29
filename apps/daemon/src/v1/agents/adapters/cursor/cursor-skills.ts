import { join } from 'node:path';

import type { AgentSkillEntry, AgentSkillsInput } from '../adapter.types';
import { scanCommandFiles } from '../skill-scan';

/**
 * Where cursor-agent keeps what it can be invoked with: commands as
 * `.cursor/commands/*.md`, in the project folder and in `~`. It has no skills
 * convention — only claude does — so there is no skills root to scan.
 *
 * Project before user, matching the shadowing the CLI applies.
 */
export async function scanCursorSkills({
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
      ...(await scanCommandFiles(join(dir, '.cursor', 'commands'), source)),
    );
  }
  return found;
}
