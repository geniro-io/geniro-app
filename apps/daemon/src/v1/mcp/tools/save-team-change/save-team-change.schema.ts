import { toolInputSchema } from '../tool-args';
import {
  BuilderTeamChangeArgsSchema,
  SaveTeamChangeArgsSchema,
} from './save-team-change.reader';

/**
 * `save_team_change`'s arguments — generated from the schema they are
 * parsed with. A builder chat sends no recommendation ids.
 */
export function saveTeamChangeSchema(
  forBuilder: boolean,
): Record<string, unknown> {
  return toolInputSchema(
    forBuilder ? BuilderTeamChangeArgsSchema : SaveTeamChangeArgsSchema,
  );
}
