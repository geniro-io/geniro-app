import type { BrowserRunOutcome } from '../../../agents/chat.types';
import type { BrowserBroker } from '../../../agents/services/browser.broker';
import type { BrowserOp } from '../../../browser/browser.types';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
  ToolArgs,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import {
  browserDoneText,
  browserStoppedText,
  PAGE_CONTENT_PREFACE,
} from './browser-outcome';

type DoneOutcome = Extract<BrowserRunOutcome, { status: 'done' }>;

/**
 * The half every `browser_*` tool shares: offered where the run's window can
 * be driven, one operation sent through the broker under the call's
 * cancellation, and the outcome worded. A tool names itself, reads its
 * arguments into the operation and says what it is for.
 */
export abstract class BrowserTool extends BaseMcpTool {
  /** True for a tool whose result is page text, which is led by the untrusted-data line. */
  protected readonly readsPage: boolean = false;

  constructor(protected readonly broker: BrowserBroker) {
    super();
  }

  /** The arguments as the operation main runs; never throws. */
  protected abstract readOp(args: Record<string, unknown>): ToolArgs<BrowserOp>;

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.broker.canDrive(runId, memberId);
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const read = this.readOp(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const { runId, memberId, gone } = context;
    const outcome = await context.whileCancellable((cancel) =>
      this.broker.run(
        runId,
        memberId,
        read.query,
        gone === undefined ? cancel : AbortSignal.any([cancel, gone]),
      ),
    );
    if (outcome.status === 'done') {
      return this.done(outcome, runId);
    }
    const stopped = browserStoppedText(outcome);
    return this.text(stopped.text, stopped.isError);
  }

  protected done(outcome: DoneOutcome, _runId: string): McpToolResult {
    const text = browserDoneText(outcome.text, outcome.tab);
    return this.text(
      this.readsPage ? `${PAGE_CONTENT_PREFACE}\n${text}` : text,
    );
  }
}
