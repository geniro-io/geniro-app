import { Logger } from '@nestjs/common';
import { BaseException } from '@packages/common';

import { HOST_READ_TEAMS_TOOL } from '../../../agents/chat.types';
import type { TeamBuilderBroker } from '../../../agents/services/team-builder.broker';
import type { TeamProposalBroker } from '../../../agents/services/team-proposal.broker';
import type { TeamStoreService } from '../../../teams/services/team-store.service';
import { firstLineOf } from '../../../teams/utils/config-dir-redaction';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { readTeamsInstructions } from './read-teams.instructions';
import { readReadTeamsArgs, teamListText, teamText } from './read-teams.reader';
import { readTeamsSchema } from './read-teams.schema';

/**
 * `read_teams` — the team library, read by an ordinary chat (ahead of
 * `propose_team`) or by a team's builder chat (ahead of
 * `save_team_change`).
 */
export class ReadTeamsTool extends BaseMcpTool {
  readonly name = HOST_READ_TEAMS_TOOL;
  private readonly logger = new Logger(ReadTeamsTool.name);

  constructor(
    private readonly gate: TeamProposalBroker,
    private readonly builders: TeamBuilderBroker,
    private readonly store: TeamStoreService,
  ) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return (
      this.gate.canPropose(runId, nodeId) ||
      this.builders.canEdit(runId, nodeId)
    );
  }

  protected instructions({ runId, nodeId }: McpListContext): string {
    return readTeamsInstructions(this.builders.canEdit(runId, nodeId));
  }

  protected inputSchema(): Record<string, unknown> {
    return readTeamsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId } = context;
    const read = readReadTeamsArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    // A call is not checked against the listing, so the gate is asked again.
    if (!this.isOffered(context)) {
      return this.text(
        "Not read: the team library is offered to ordinary chats and a team's builder chat only.",
        true,
      );
    }
    const { slug } = read.query;
    try {
      return this.text(
        slug === undefined
          ? teamListText(await this.store.list())
          : teamText(await this.store.get(slug)),
      );
    } catch (error) {
      if (error instanceof BaseException) {
        // A YAML parse error quotes the file's lines around the fault, a
        // profile path among them: the first line names the fault alone.
        return this.text(
          `${error.errorCode}: ${firstLineOf(error.message)}`,
          true,
        );
      }
      // Logged and replaced: a filesystem error names a path under the user's
      // home, and this answer goes to a model whose provider is off the machine.
      this.logger.error(
        `run ${runId} could not read the team library: ${error instanceof Error ? error.message : String(error)}`,
      );
      const code = (error as NodeJS.ErrnoException).code;
      return this.text(
        `Not read: the team library could not be read${code ? ` (${code})` : ''}.`,
        true,
      );
    }
  }
}
