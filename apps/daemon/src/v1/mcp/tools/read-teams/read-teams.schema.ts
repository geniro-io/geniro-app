import { toolInputSchema } from '../tool-args';
import { ReadTeamsArgsSchema } from './read-teams.reader';

/** `read_teams`'s arguments, generated from the schema they are read with. */
export function readTeamsSchema(): Record<string, unknown> {
  return toolInputSchema(ReadTeamsArgsSchema);
}
