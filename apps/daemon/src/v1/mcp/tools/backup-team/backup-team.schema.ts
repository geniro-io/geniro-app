import { toolInputSchema } from '../tool-args';
import { BackupTeamArgsSchema } from './backup-team.reader';

/** `backup_team`'s arguments — none, generated from the schema they are parsed with. */
export function backupTeamSchema(): Record<string, unknown> {
  return toolInputSchema(BackupTeamArgsSchema);
}
