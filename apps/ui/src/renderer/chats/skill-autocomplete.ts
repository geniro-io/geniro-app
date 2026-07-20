import type { AgentSkill } from '../../shared/contracts';

/**
 * Pure logic behind the composer's `/` skill autocomplete (the Claude
 * Code / Cursor pattern): the menu is open exactly while the WHOLE input is
 * one slash token still being typed (`/`, `/de`, …). The first space (the
 * arguments) or any other leading text closes it — matching when the CLIs'
 * own pickers show and hide theirs.
 */

/** The skill-name query of an input that is one slash token, else null. */
export function slashQuery(input: string): string | null {
  const match = /^\/(\S*)$/.exec(input);
  return match ? match[1]! : null;
}

/** Prefix matches first (the common case), then substring matches; stable. */
export function filterSkills(
  skills: readonly AgentSkill[],
  query: string,
): AgentSkill[] {
  const lower = query.toLowerCase();
  const prefixed: AgentSkill[] = [];
  const infixed: AgentSkill[] = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    if (name.startsWith(lower)) {
      prefixed.push(skill);
    } else if (name.includes(lower)) {
      infixed.push(skill);
    }
  }
  return [...prefixed, ...infixed];
}

/** The composer text after picking a skill — trailing space, ready for args. */
export function applySkill(skill: AgentSkill): string {
  return `/${skill.name} `;
}

/**
 * Union the per-agent-kind lists (a workflow trigger can fan out to mixed
 * agents), de-duped by name — first list wins, mirroring the daemon's own
 * first-occurrence-wins collision rule. Order is PRESERVED, not re-sorted:
 * the daemon ranks each list (project → user → cli-reported) so the user's
 * own skills lead the popup; later lists' new names append in their order.
 */
export function mergeSkills(
  lists: readonly (readonly AgentSkill[])[],
): AgentSkill[] {
  const byName = new Map<string, AgentSkill>();
  for (const list of lists) {
    for (const skill of list) {
      if (!byName.has(skill.name)) {
        byName.set(skill.name, skill);
      }
    }
  }
  return [...byName.values()];
}
