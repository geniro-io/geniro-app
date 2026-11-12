import { Logger } from '@nestjs/common';
import { BaseException } from '@packages/common';

import { HOST_READ_TEAMS_TOOL } from '../../../agents/chat.types';
import type { TeamProposalBroker } from '../../../agents/services/team-proposal.broker';
import type { TeamOverlayService } from '../../../teams/services/team-overlay.service';
import type { TeamProposalService } from '../../../teams/services/team-proposal.service';
import type { TeamStoreService } from '../../../teams/services/team-store.service';
import { firstLineOf } from '../../../teams/utils/config-dir-redaction';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { readTeamsInstructions } from './read-teams.instructions';
import {
  readReadTeamsArgs,
  teamListText,
  teamOrOutlineText,
  teamOverlaysText,
  teamProjectsText,
  teamReadOf,
  teamReadText,
} from './read-teams.reader';
import { readTeamsSchema } from './read-teams.schema';

/**
 * `read_teams` — the team library, read by any chat and by a team run's lead,
 * ahead of `propose_team` or to bring text from one team to another.
 */
export class ReadTeamsTool extends BaseMcpTool {
  readonly name = HOST_READ_TEAMS_TOOL;
  private readonly logger = new Logger(ReadTeamsTool.name);

  constructor(
    private readonly gate: TeamProposalBroker,
    private readonly store: TeamStoreService,
    private readonly overlays: TeamOverlayService,
    private readonly proposals: TeamProposalService,
  ) {
    super();
  }

  protected isOffered({
    runId,
    memberId,
    conversationId,
  }: McpListContext): boolean {
    return this.gate.canPropose(runId, memberId, conversationId);
  }

  protected instructions(): string {
    return readTeamsInstructions();
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
        'Not read: the team library is offered to chats and to the lead of a team run in its own conversation, never to another member.',
        true,
      );
    }
    const slug = read.query.slug;
    const teamRead = teamReadOf(read.query);
    if (typeof teamRead === 'string') {
      return this.text(teamRead, true);
    }
    if (slug === undefined && teamRead.kind !== 'team') {
      return this.text(
        'Not read: name the team with `slug` — the listing (no arguments) names every one.',
        true,
      );
    }
    try {
      if (slug === undefined) {
        return this.text(teamListText(await this.store.list()));
      }
      const wire = await this.store.get(slug);
      switch (teamRead.kind) {
        case 'team':
          return this.text(teamOrOutlineText(wire));
        case 'overlays':
          return this.text(
            teamOverlaysText(
              wire,
              await this.overlays.overlaySources(slug),
              teamRead.offset,
            ),
          );
        case 'projects':
          return this.text(
            teamProjectsText(
              wire,
              await this.proposals.projectsRunning(slug),
              teamRead.offset,
            ),
          );
        default:
          return this.text(teamReadText(wire, teamRead));
      }
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
