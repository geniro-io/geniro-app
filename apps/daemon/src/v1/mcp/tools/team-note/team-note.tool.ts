import { HOST_TEAM_NOTE_TOOL } from '../../../agents/chat.types';
import type { TeamNoteBroker } from '../../../agents/services/team-note.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { teamNoteInstructions } from './team-note.instructions';
import { readTeamNote, teamNoteResultText } from './team-note.reader';
import { teamNoteSchema } from './team-note.schema';

/** `team_note` — write a note every agent of this workflow run can read. */
export class TeamNoteTool extends BaseMcpTool {
  readonly name = HOST_TEAM_NOTE_TOOL;

  constructor(private readonly notes: TeamNoteBroker) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.notes.canUse(runId, nodeId);
  }

  protected instructions(): string {
    return teamNoteInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return teamNoteSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    const input = readTeamNote(args);
    if ('error' in input) {
      return this.invalidArgs(input.error);
    }
    const outcome = await this.notes.write(runId, nodeId, caller, input);
    return outcome.status === 'refused'
      ? this.invalidArgs(outcome.reason)
      : this.text(teamNoteResultText(outcome));
  }
}
