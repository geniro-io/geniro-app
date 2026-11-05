import { toolInputSchema } from '../tool-args';
import type { ReadTeamsAudience } from './read-teams.instructions';
import { readTeamsArgsSchema } from './read-teams.reader';

/** `read_teams`'s arguments, generated from the schema each audience is read with: a project's chat names no slug. */
export function readTeamsSchema(
  audience: ReadTeamsAudience,
): Record<string, unknown> {
  return toolInputSchema(readTeamsArgsSchema(audience));
}
