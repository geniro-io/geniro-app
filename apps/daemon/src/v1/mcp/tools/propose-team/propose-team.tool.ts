import { HOST_PROPOSE_TEAM_TOOL } from '../../../agents/chat.types';
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
  readProposeTeamArgs,
  readProposeTeamChangeArgs,
} from './propose-team.reader';
import { proposeTeamSchema } from './propose-team.schema';

/**
 * `propose_team` — a team on a card the user approves: a whole one
 * from an ordinary chat, or edits to its own from a team's builder chat.
 * It does NOT wait for the answer: the card outlives the turn and the verdict
 * arrives as the run's next message (`TeamProposalService`), so no CLI's
 * tool-call deadline can expire it.
 */
export class ProposeTeamTool extends BaseMcpTool {
  readonly name = HOST_PROPOSE_TEAM_TOOL;

  constructor(
    private readonly gate: TeamProposalBroker,
    private readonly builders: TeamBuilderBroker,
    private readonly proposals: TeamProposalService,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return (
      this.gate.canPropose(runId, memberId) ||
      this.builders.canEdit(runId, memberId)
    );
  }

  protected instructions({ runId, memberId }: McpListContext): string {
    return proposeTeamInstructions(this.builders.canEdit(runId, memberId));
  }

  protected inputSchema({
    runId,
    memberId,
  }: McpListContext): Record<string, unknown> {
    return proposeTeamSchema(this.builders.canEdit(runId, memberId));
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
    const outcome = await this.proposals.propose(runId, read.query);
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
    const outcome = await this.proposals.proposeChange(runId, {
      ...read.query,
      slug: turn.slug,
    });
    return this.text(
      proposeTeamResultText(outcome),
      outcome.status === 'refused',
    );
  }
}
