import type { Team } from '../teams.types';
import { restoreConfigDirs } from './config-dir-redaction';
import { checkTeam } from './team-check';
import { applyTeamEdits, type TeamEdit } from './team-edits';

/** Where a builder chat copies a `find` from: the file it read with its own tools. */
export const TEAM_FILE_EDIT_COPY =
  'the team file, as the string value itself rather than its YAML quoting or line folding';

export type EditedTeam =
  | { ok: true; team: Team }
  | {
      ok: false;
      error: 'INVALID_EDIT' | 'INVALID_TEAM' | 'CONFIG_DIR_UNKNOWN';
      message: string;
    };

/**
 * `edits` carried out on `current` and the result held to the schema and the
 * team rules — what `save_team_change` and a builder chat's
 * `propose_team` both write. With `restoreTokens`, a `configDir` written
 * back as a `read_teams` token gets its path back from `current`.
 */
export function editTeam(
  current: Team,
  edits: readonly TeamEdit[],
  copyFrom: string,
  restoreTokens: boolean,
): EditedTeam {
  const edited = applyTeamEdits(current, edits, copyFrom);
  if (!edited.ok) {
    return { ok: false, error: 'INVALID_EDIT', message: edited.message };
  }
  const checked = checkTeam(edited.team);
  if (!checked.ok) {
    return { ok: false, error: 'INVALID_TEAM', message: checked.message };
  }
  if (!restoreTokens) {
    return checked;
  }
  const restored = restoreConfigDirs(checked.team, current);
  return restored.ok
    ? restored
    : { ok: false, error: 'CONFIG_DIR_UNKNOWN', message: restored.message };
}
