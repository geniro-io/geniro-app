import { Logger } from '@nestjs/common';
import { BaseException } from '@packages/common';

import { HOST_READ_TEAMS_TOOL } from '../../../agents/chat.types';
import type { ProjectChatBroker } from '../../../agents/services/project-chat.broker';
import type { TeamBuilderBroker } from '../../../agents/services/team-builder.broker';
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
import {
  type ReadTeamsAudience,
  readTeamsInstructions,
} from './read-teams.instructions';
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
 * `read_teams` — the team library, read by an ordinary chat (ahead of
 * `propose_team`) or by a team's builder chat (ahead of
 * `save_team_change`); in a project's own chat, the one team its project
 * runs with, which that chat may not change.
 */
export class ReadTeamsTool extends BaseMcpTool {
  readonly name = HOST_READ_TEAMS_TOOL;
  private readonly logger = new Logger(ReadTeamsTool.name);

  constructor(
    private readonly gate: TeamProposalBroker,
    private readonly builders: TeamBuilderBroker,
    private readonly projectChats: ProjectChatBroker,
    private readonly store: TeamStoreService,
    private readonly overlays: TeamOverlayService,
    private readonly proposals: TeamProposalService,
  ) {
    super();
  }

  private projectTeamOf(runId: string, memberId: string): string | null {
    return this.projectChats.projectOf(runId, memberId)?.teamSlug ?? null;
  }

  private audienceOf(runId: string, memberId: string): ReadTeamsAudience {
    if (this.builders.canEdit(runId, memberId)) {
      return 'builder';
    }
    return this.projectTeamOf(runId, memberId) === null ? 'chat' : 'project';
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return (
      this.gate.canPropose(runId, memberId) ||
      this.builders.canEdit(runId, memberId) ||
      this.projectTeamOf(runId, memberId) !== null
    );
  }

  protected instructions({ runId, memberId }: McpListContext): string {
    return readTeamsInstructions(this.audienceOf(runId, memberId));
  }

  protected inputSchema({
    runId,
    memberId,
  }: McpListContext): Record<string, unknown> {
    return readTeamsSchema(this.audienceOf(runId, memberId));
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    const read = readReadTeamsArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    // A call is not checked against the listing, so the gate is asked again.
    if (!this.isOffered(context)) {
      return this.text(
        "Not read: the team library is offered to ordinary chats, a team's builder chat and the chat of a project a team runs.",
        true,
      );
    }
    const projectTeam =
      this.audienceOf(runId, memberId) === 'project'
        ? this.projectTeamOf(runId, memberId)
        : null;
    if (
      projectTeam !== null &&
      read.query.slug !== undefined &&
      read.query.slug !== projectTeam
    ) {
      return this.text(
        `Not read: this chat reads only its project's team, \`${projectTeam}\`. Call it with no arguments.`,
        true,
      );
    }
    const slug = projectTeam ?? read.query.slug;
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
    const audience = this.audienceOf(runId, memberId);
    if (
      teamRead.kind === 'projects' ||
      (teamRead.kind === 'overlays' && audience !== 'chat')
    ) {
      const own = await this.builders.teamOf(runId, memberId);
      if ('status' in own) {
        return this.text(
          `Not read: a team's ${teamRead.kind} are read in that team's builder chat.`,
          true,
        );
      }
      if (own.slug !== slug) {
        return this.text(
          `Not read: this chat reads the ${teamRead.kind} of the team it edits, \`${own.slug}\`.`,
          true,
        );
      }
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
              audience !== 'chat',
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
