import type { Team } from '../teams.types';
import { restoreConfigDirs } from './config-dir-redaction';
import { checkTeam } from './team-check';
import { applyTeamEdits, type TeamEdit } from './team-edits';

/** Where a builder chat copies a `find` from: what `read_teams` answered. */
export const TEAM_FILE_EDIT_COPY =
  'read_teams — the text between a field’s `===` markers, or the decoded JSON string — never the YAML file’s quoting or line folding';

export type EditedTeam =
  | { ok: true; team: Team; landed: string[] }
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
    return { ...checked, landed: edited.landed };
  }
  const restored = restoreConfigDirs(checked.team, current);
  return restored.ok
    ? { ...restored, landed: edited.landed }
    : { ok: false, error: 'CONFIG_DIR_UNKNOWN', message: restored.message };
}
