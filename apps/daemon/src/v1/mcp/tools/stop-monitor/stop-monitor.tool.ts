import { HOST_STOP_MONITOR_TOOL } from '../../../agents/chat.types';
import type { MonitorBroker } from '../../../agents/services/monitor.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { stopMonitorInstructions } from './stop-monitor.instructions';
import { readStopMonitor, stopMonitorResultText } from './stop-monitor.reader';
import { stopMonitorSchema } from './stop-monitor.schema';

/** `stop_monitor` — end one of this conversation's monitors early. */
export class StopMonitorTool extends BaseMcpTool {
  readonly name = HOST_STOP_MONITOR_TOOL;

  constructor(private readonly monitors: MonitorBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.monitors.canMonitor(runId, memberId);
  }

  protected instructions(): string {
    return stopMonitorInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return stopMonitorSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    const input = readStopMonitor(args);
    if ('error' in input) {
      return this.invalidArgs(input.error);
    }
    const outcome = await this.monitors.stop(runId, memberId, input.id, caller);
    return outcome.status === 'refused'
      ? this.invalidArgs(outcome.reason)
      : this.text(stopMonitorResultText(outcome, input.id));
  }
}
