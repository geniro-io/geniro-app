import { HOST_PROPOSE_TEAM_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { ProjectChatBroker } from '../../../agents/services/project-chat.broker';
import type { TeamBuilderBroker } from '../../../agents/services/team-builder.broker';
import type { TeamProposalBroker } from '../../../agents/services/team-proposal.broker';
import type { TeamProposalService } from '../../../teams/services/team-proposal.service';
import type { ProposalOutcome } from '../../../teams/teams.types';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { proposeTeamInstructions } from './propose-team.instructions';
import {
  proposalTargetOf,
  proposeTeamResultText,
  readProposeTeamArgs,
} from './propose-team.reader';
import {
  type ProposeTeamAudience,
  proposeTeamSchema,
} from './propose-team.schema';

/**
 * `propose_team` — a team on a card the user approves, from any chat: a new
 * one, edits to any library team, any project's overlay of its default team,
 * or edits with what moves to a project beside them. A builder chat's and a
 * project chat's own team and project are only what a call naming none means.
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
    private readonly analysis: AnalysisBroker,
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

  private audienceOf(runId: string, memberId: string): ProposeTeamAudience {
    if (this.builders.canEdit(runId, memberId)) {
      return 'builder';
    }
    if (this.projectChats.canEdit(runId, memberId)) {
      return 'project';
    }
    return this.analysis.canAnalyse(runId, memberId) ? 'analysis' : 'chat';
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
    if (!this.isOffered(context)) {
      return this.text(
        'Not proposed: teams are proposed from a chat or by the lead of a team run in its own conversation, never by another member.',
        true,
      );
    }
    const read = readProposeTeamArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const query = read.query;
    if ('team' in query) {
      return this.answer(await this.proposals.propose(runId, query));
    }
    let ownTeam: string | null = null;
    let ownProject =
      this.projectChats.projectOf(runId, memberId)?.projectId ?? null;
    if (this.builders.canEdit(runId, memberId)) {
      const turn = await this.builders.teamOf(runId, memberId);
      if ('status' in turn) {
        return this.text(`Not proposed: ${turn.reason}.`, true);
      }
      ownTeam = turn.slug;
      ownProject = turn.projectId;
    }
    const target = proposalTargetOf(query, {
      team: ownTeam,
      project: ownProject,
    });
    if (typeof target === 'string') {
      return this.invalidArgs(target);
    }
    const { summary, reason, recommendationIds } = query;
    const ids = recommendationIds === undefined ? {} : { recommendationIds };
    if (target.kind === 'overlay') {
      return this.answer(
        await this.proposals.proposeOverlay(runId, {
          projectId: target.projectId,
          overlay: target.overlay,
          summary,
          reason,
          ...ids,
        }),
      );
    }
    const change = {
      slug: target.slug,
      edits: query.edits,
      projectId: target.projectId,
      summary,
      reason,
      ...(query.overlay === undefined ? {} : { overlay: query.overlay }),
      ...(query.project === undefined ? {} : { project: query.project }),
      ...ids,
    };
    return this.answer(
      target.slug === ownTeam
        ? await this.proposals.proposeChange(runId, change)
        : await this.proposals.proposeEdits(runId, change),
    );
  }

  private answer(outcome: ProposalOutcome): McpToolResult {
    return this.text(
      proposeTeamResultText(outcome),
      outcome.status === 'refused',
    );
  }
}
