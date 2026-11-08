import { HOST_PROPOSE_TEAM_TOOL } from '../../../agents/chat.types';
import type { ProjectChatBroker } from '../../../agents/services/project-chat.broker';
import type { TeamBuilderBroker } from '../../../agents/services/team-builder.broker';
import type { TeamProposalBroker } from '../../../agents/services/team-proposal.broker';
import type { TeamProposalService } from '../../../teams/services/team-proposal.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { proposeTeamInstructions } from './propose-team.instructions';
import {
  proposeTeamResultText,
  readProposeProjectOverlayArgs,
  readProposeTeamArgs,
  readProposeTeamChangeArgs,
} from './propose-team.reader';
import {
  type ProposeTeamAudience,
  proposeTeamSchema,
} from './propose-team.schema';

/**
 * `propose_team` — a team on a card the user approves: a new one or edits to
 * a library team from an ordinary chat, edits to its own from a team's builder chat, or a
 * project's overlay of its default team from that project's own chat.
 * It does NOT wait for the answer: the card outlives the turn and the verdict
 * arrives as the run's next message (`TeamProposalService`), so no CLI's
 * tool-call deadline can expire it.
 */
export class ProposeTeamTool extends BaseMcpTool {
  readonly name = HOST_PROPOSE_TEAM_TOOL;

  constructor(
    private readonly gate: TeamProposalBroker,
    private readonly builders: TeamBuilderBroker,
    private readonly projectChats: ProjectChatBroker,
    private readonly proposals: TeamProposalService,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return (
      this.gate.canPropose(runId, memberId) ||
      this.builders.canEdit(runId, memberId) ||
      this.projectChats.canProposeOverlay(runId, memberId)
    );
  }

  private audienceOf(runId: string, memberId: string): ProposeTeamAudience {
    if (this.builders.canEdit(runId, memberId)) {
      return 'builder';
    }
    return this.projectChats.canProposeOverlay(runId, memberId)
      ? 'project'
      : 'chat';
  }

  protected instructions({ runId, memberId }: McpListContext): string {
    return proposeTeamInstructions(this.audienceOf(runId, memberId));
  }

  protected inputSchema({
    runId,
    memberId,
  }: McpListContext): Record<string, unknown> {
    return proposeTeamSchema(this.audienceOf(runId, memberId));
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    // A call is not checked against the listing, so the gate is asked again.
    if (this.builders.canEdit(runId, memberId)) {
      return this.proposeChange(args, runId, memberId);
    }
    const projectChat = this.projectChats.projectOf(runId, memberId);
    if (projectChat?.teamSlug != null) {
      return this.proposeOverlay(
        args,
        runId,
        projectChat.teamSlug,
        projectChat.projectId,
      );
    }
    const read = readProposeTeamArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    if (!this.gate.canPropose(runId, memberId)) {
      return this.text(
        "Not proposed: teams are proposed from ordinary chats and a team's own builder chat only.",
        true,
      );
    }
    const query = read.query;
    const outcome =
      'overlay' in query
        ? await this.proposals.proposeOverlay(runId, {
            projectId: query.overlayProjectId,
            overlay: query.overlay,
            summary: query.summary,
            reason: query.reason,
          })
        : 'edits' in query
          ? await this.proposals.proposeEdits(runId, {
              slug: query.replaces,
              edits: query.edits,
              summary: query.summary,
              reason: query.reason,
            })
          : await this.proposals.propose(runId, query);
    return this.text(
      proposeTeamResultText(outcome),
      outcome.status === 'refused',
    );
  }

  private async proposeChange(
    args: Record<string, unknown>,
    runId: string,
    memberId: string,
  ): Promise<McpToolResult> {
    const read = readProposeTeamChangeArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.builders.teamOf(runId, memberId);
    if ('status' in turn) {
      return this.text(`Not proposed: ${turn.reason}.`, true);
    }
    if (read.query.overlay !== undefined && turn.projectId === null) {
      return this.text(
        'Not proposed: this chat edits the shared team only — an overlay is proposed from a chat opened in a project scope.',
        true,
      );
    }
    const outcome = await this.proposals.proposeChange(runId, {
      ...read.query,
      slug: turn.slug,
      projectId: turn.projectId,
    });
    return this.text(
      proposeTeamResultText(outcome),
      outcome.status === 'refused',
    );
  }

  private async proposeOverlay(
    args: Record<string, unknown>,
    runId: string,
    slug: string,
    projectId: string,
  ): Promise<McpToolResult> {
    const read = readProposeProjectOverlayArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const outcome = await this.proposals.proposeChange(runId, {
      ...read.query,
      edits: [],
      slug,
      projectId,
    });
    return this.text(
      proposeTeamResultText(outcome),
      outcome.status === 'refused',
    );
  }
}
