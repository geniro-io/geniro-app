import { BaseException } from '@packages/common';

import { type Team, TeamSchema } from '../teams.types';
import { assertValidTeam } from './team-validate';

export type TeamCheck =
  | { ok: true; team: Team }
  /** `code` is the team rule's own (`TEAM_…`, `STAGE_…`), or `INVALID_TEAM`. */
  | { ok: false; code: string; message: string };

/**
 * An agent's team JSON read as a library file would have to be: the
 * default-free `TeamSchema` (never `TeamYamlSchema`, whose defaults would
 * quietly give a member `approval: 'auto'`) and the team rules. The message
 * names at most five schema issues.
 */
export function checkTeam(input: unknown): TeamCheck {
  const parsed = TeamSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'INVALID_TEAM',
      message: parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }
  try {
    assertValidTeam(parsed.data);
  } catch (error) {
    return {
      ok: false,
      code: error instanceof BaseException ? error.errorCode : 'INVALID_TEAM',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, team: parsed.data };
}
