import { HOST_ARCHIVE_THREADS_TOOL } from '../../../agents/chat.types';
import type { CommandCenterBroker } from '../../../agents/services/command-center.broker';
import type { CommandCenterOpsBroker } from '../../../agents/services/command-center-ops.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { archiveThreadsInstructions } from './archive-threads.instructions';
import {
  archiveThreadsResultText,
  readArchiveThreadsArgs,
} from './archive-threads.reader';
import { archiveThreadsSchema } from './archive-threads.schema';

/**
 * `archive_threads` — offered only on a command-center manager turn. `tools/call`
 * skips `isOffered`, so the command center refuses any other run from its row.
 */
export class ArchiveThreadsTool extends BaseMcpTool {
  readonly name = HOST_ARCHIVE_THREADS_TOOL;

  constructor(
    private readonly managers: CommandCenterBroker,
    private readonly ops: CommandCenterOpsBroker,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.managers.canManage(runId, memberId);
  }

  protected instructions(): string {
    return archiveThreadsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return archiveThreadsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readArchiveThreadsArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const answer = await this.ops.archive(runId, read.query);
    return 'error' in answer
      ? this.text(answer.error, true)
      : this.text(archiveThreadsResultText(answer));
  }
}
