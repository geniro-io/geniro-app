import { z } from 'zod';

import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** No arguments: the team is the builder chat's own. */
export const BackupTeamArgsSchema = z.object({});

/** A `backup_team` call's arguments, or why they cannot be read. */
export function readBackupTeamArgs(
  args: Record<string, unknown>,
): ToolArgs<Record<string, never>> {
  return readToolArgs(BackupTeamArgsSchema.strict(), args);
}

/** The answer as the agent reads it, and whether it is a refusal. */
export function backupResultText(answer: Record<string, unknown>): {
  text: string;
  isError: boolean;
} {
  return { text: JSON.stringify(answer), isError: 'error' in answer };
}
