import { toolInputSchema } from '../tool-args';
import { BackupWorkflowArgsSchema } from './backup-workflow.reader';

/** `backup_workflow`'s arguments — none, generated from the schema they are parsed with. */
export function backupWorkflowSchema(): Record<string, unknown> {
  return toolInputSchema(BackupWorkflowArgsSchema);
}
