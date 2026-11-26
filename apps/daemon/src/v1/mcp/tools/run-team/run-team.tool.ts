import { HOST_RUN_TEAM_TOOL } from '../../../agents/chat.types';
import type { TeamProposalBroker } from '../../../agents/services/team-proposal.broker';
import type { ChatTeamService } from '../../../teams/services/chat-team.service';
import type { TeamProposalService } from '../../../teams/services/team-proposal.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { runTeamInstructions } from './run-team.instructions';
import {
  readRunTeamChangeArgs,
  readRunTeamStartArgs,
  runTeamResultText,
} from './run-team.reader';
import { runTeamSchema } from './run-team.schema';

/**
 * `run_team` — an ordinary chat's agent proposes a team on a card, and the
 * same chat becomes that team when the user presses Start; a team run's lead
 * changes its team for that run on the same kind of card. It does NOT wait for
 * the answer: the verdict arrives as the run's next message.
 */
export class RunTeamTool extends BaseMcpTool {
  readonly name = HOST_RUN_TEAM_TOOL;

  constructor(
    private readonly gate: TeamProposalBroker,
    private readonly proposals: TeamProposalService,
    private readonly chatTeams: ChatTeamService,
  ) {
    super();
  }

  protected isOffered({
    runId,
    memberId,
    conversationId,
  }: McpListContext): boolean {
    return this.gate.runTeamFormOf(runId, memberId, conversationId) !== null;
  }

  protected instructions(): string {
    return runTeamInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return runTeamSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId, conversationId } = context;
    const form = this.gate.runTeamFormOf(runId, memberId, conversationId);
    if (form === null) {
      return this.text(
        'Not proposed: a team is started from an ordinary chat, and changed only by the lead of a running team in its own conversation.',
        true,
      );
    }
    if (form === 'start') {
      const read = readRunTeamStartArgs(args);
      if (!read.ok) {
        return this.invalidArgs(read.error);
      }
      const outcome = await this.proposals.proposeRunTeam(runId, () =>
        this.chatTeams.prepareStart(runId, read.query),
      );
      return this.answerTo(
        outcome,
        runTeamResultText(outcome),
        outcome.status === 'refused',
      );
    }
    const read = readRunTeamChangeArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const remark = await this.chatTeams.applyRemarkChange(runId, read.query);
    if (remark !== null && (remark.refused || remark.rest.length === 0)) {
      return this.text(remark.text, remark.refused);
    }
    const query =
      remark === null ? read.query : { ...read.query, edits: remark.rest };
    const outcome = await this.proposals.proposeRunTeam(runId, () =>
      this.chatTeams.prepareChange(runId, query),
    );
    const card = runTeamResultText(outcome);
    return this.answerTo(
      outcome,
      remark === null ? card : `${remark.text}\n${card}`,
      remark === null && outcome.status === 'refused',
    );
  }
}
