import { HOST_MONITOR_TOOL } from '../../../agents/chat.types';
import type { MonitorBroker } from '../../../agents/services/monitor.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { monitorInstructions } from './monitor.instructions';
import { monitorResultText, readMonitor } from './monitor.reader';
import { monitorSchema } from './monitor.schema';

/** `monitor` — run a command and wake the agent with its output. */
export class MonitorTool extends BaseMcpTool {
  readonly name = HOST_MONITOR_TOOL;

  constructor(private readonly monitors: MonitorBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.monitors.canMonitor(runId, memberId);
  }

  protected instructions(): string {
    return monitorInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return monitorSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    const input = readMonitor(args);
    if ('error' in input) {
      return this.invalidArgs(input.error);
    }
    const outcome = await this.monitors.start(runId, memberId, input, caller);
    return outcome.status === 'refused'
      ? this.invalidArgs(outcome.reason)
      : this.text(monitorResultText(outcome));
  }
}
