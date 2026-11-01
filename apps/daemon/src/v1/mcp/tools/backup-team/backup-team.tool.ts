import { Logger } from '@nestjs/common';

import { HOST_BACKUP_TEAM_TOOL } from '../../../agents/chat.types';
import type { TeamBuilderBroker } from '../../../agents/services/team-builder.broker';
import type { TeamChangeService } from '../../../teams/services/team-change.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { backupTeamInstructions } from './backup-team.instructions';
import { backupResultText, readBackupTeamArgs } from './backup-team.reader';
import { backupTeamSchema } from './backup-team.schema';

/**
 * `backup_team` — a team builder chat's backup of its own file, taken
 * when the user asks for one; an approved `propose_team` card takes its
 * own before it saves.
 */
export class BackupTeamTool extends BaseMcpTool {
  readonly name = HOST_BACKUP_TEAM_TOOL;
  private readonly logger = new Logger(BackupTeamTool.name);

  constructor(
    private readonly builders: TeamBuilderBroker,
    private readonly teams: TeamChangeService,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.builders.canEdit(runId, memberId);
  }

  protected instructions(): string {
    return backupTeamInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return backupTeamSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readBackupTeamArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.builders.teamOf(runId, memberId);
    if ('status' in turn) {
      return this.text(`Nothing backed up: ${turn.reason}.`, true);
    }
    try {
      const result = backupResultText(await this.teams.backUp(turn.slug));
      return this.text(result.text, result.isError);
    } catch (error) {
      this.logger.error(
        `run ${runId} could not back up a team: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.text(
        `${this.name} failed internally — nothing was backed up.`,
        true,
      );
    }
  }
}
