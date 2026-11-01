import { HOST_TEAM_NOTES_TOOL } from '../../../agents/chat.types';
import type { TeamNoteBroker } from '../../../agents/services/team-note.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { teamNotesInstructions } from './team-notes.instructions';
import { readTeamNotes, teamNotesResultText } from './team-notes.reader';
import { teamNotesSchema } from './team-notes.schema';

/** `team_notes` — read the notes every agent of this team run wrote. */
export class TeamNotesTool extends BaseMcpTool {
  readonly name = HOST_TEAM_NOTES_TOOL;

  constructor(private readonly notes: TeamNoteBroker) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.notes.canUse(runId, nodeId);
  }

  protected instructions(): string {
    return teamNotesInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return teamNotesSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    const query = readTeamNotes(args);
    if ('error' in query) {
      return this.invalidArgs(query.error);
    }
    return this.text(
      teamNotesResultText(await this.notes.read(runId, nodeId, caller, query)),
    );
  }
}
