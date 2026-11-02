import { Logger } from '@nestjs/common';

import {
  type GoalActor,
  type GoalsWriteOutcome,
  HOST_GOALS_TOOL,
} from '../../../agents/chat.types';
import type { GoalsService } from '../../../agents/services/goals.service';
import type { McpCallContext, McpToolResult } from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { goalsInstructions } from './goals.instructions';
import {
  type GoalsCall,
  goalsListText,
  goalsResultText,
  readGoals,
} from './goals.reader';
import { goalsSchema } from './goals.schema';

/** `goals` — record a task's goals and close each with evidence. Offered in every run. */
export class GoalsTool extends BaseMcpTool {
  readonly name = HOST_GOALS_TOOL;
  private readonly logger = new Logger(GoalsTool.name);

  constructor(private readonly goals: GoalsService) {
    super();
  }

  protected isOffered(): boolean {
    return true;
  }

  protected instructions(): string {
    return goalsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return goalsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId }: McpCallContext,
  ): Promise<McpToolResult> {
    const call = readGoals(args);
    if ('error' in call) {
      return this.invalidArgs(call.error);
    }
    const actor: GoalActor = { kind: 'agent', memberId };
    try {
      if (call.action === 'list') {
        const goals = await this.goals.list(runId);
        return goals === null
          ? this.text('This run no longer exists.', true)
          : this.text(goalsListText(goals));
      }
      const outcome = await this.write(runId, actor, call);
      const reply = goalsResultText(call.action, outcome);
      return this.text(reply.text, reply.isError);
    } catch (error) {
      this.logger.error(
        `run ${runId} could not ${call.action} its goals: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.text('Not changed: the goals could not be written.', true);
    }
  }

  private write(
    runId: string,
    actor: GoalActor,
    call: Exclude<GoalsCall, { action: 'list' }>,
  ): Promise<GoalsWriteOutcome> {
    switch (call.action) {
      case 'set':
        return this.goals.set(runId, actor, call.goals);
      case 'add':
        return this.goals.add(runId, actor, call.goals);
      case 'update':
        return this.goals.update(runId, actor, call.id, call.text);
      case 'remove':
        return this.goals.remove(runId, actor, call.id);
      case 'complete':
        return this.goals.close(
          runId,
          actor,
          call.id,
          call.status,
          call.evidence,
        );
    }
  }
}
