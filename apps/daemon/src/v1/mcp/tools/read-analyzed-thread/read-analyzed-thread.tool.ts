import { Logger } from '@nestjs/common';

import { HOST_ANALYZED_THREAD_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import {
  pagedAnswer,
  type ThreadReaderService,
} from '../../../agents/services/thread-reader.service';
import type { WorkflowChangeService } from '../../../graphs/services/workflow-change.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { readAnalyzedThreadInstructions } from './read-analyzed-thread.instructions';
import {
  analyzedThreadResultText,
  maskedAnswer,
  readAnalyzedThreadArgs,
} from './read-analyzed-thread.reader';
import { readAnalyzedThreadSchema } from './read-analyzed-thread.schema';

/**
 * `read_analyzed_thread` — an analysis chat's paged read of the one thread it
 * analyses. Offered only while an analysis turn runs, and carries no
 * `readOnlyHint` (codex would skip its approval); its auto-approval is
 * `isHostAnalysisReadCall`'s, scoped by the broker to that one source.
 */
export class ReadAnalyzedThreadTool extends BaseMcpTool {
  readonly name = HOST_ANALYZED_THREAD_TOOL;
  private readonly logger = new Logger(ReadAnalyzedThreadTool.name);

  constructor(
    private readonly analysis: AnalysisBroker,
    private readonly threads: ThreadReaderService,
    private readonly workflows: WorkflowChangeService,
  ) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.analysis.canAnalyse(runId, nodeId);
  }

  protected instructions(): string {
    return readAnalyzedThreadInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return readAnalyzedThreadSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readAnalyzedThreadArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.analysis.turnOf(runId, nodeId);
    if ('status' in turn) {
      return this.text(`Nothing to read: ${turn.reason}.`, true);
    }
    try {
      if (read.query.view !== 'workflow') {
        return this.text(
          analyzedThreadResultText(await this.threads.read(turn, read.query)),
        );
      }
      const workflow = await this.threads.workflowOf(turn.sourceRunId);
      if (workflow === null) {
        return this.text(
          analyzedThreadResultText({
            error: 'NOT_A_WORKFLOW',
            message:
              'The analysed thread is a plain chat (or is gone): it has no workflow.',
          }),
        );
      }
      return this.text(
        analyzedThreadResultText(
          pagedAnswer(
            // Masked BEFORE paging: a secret cut across two chunks matches
            // in neither, and the per-chunk pass would let both halves out.
            maskedAnswer(
              await this.workflows.describe(workflow.slug, workflow.snapshot),
            ),
            read.query.offset ?? 0,
          ),
        ),
      );
    } catch (error) {
      // A failed read names database and file paths; the model is told a
      // fixed sentence, the rule `HostSinkBroker.deliver` states.
      this.logger.error(
        `run ${runId} could not read its analysed thread: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.text(
        `${this.name} failed internally — try a narrower read, or report what you have.`,
        true,
      );
    }
  }
}
