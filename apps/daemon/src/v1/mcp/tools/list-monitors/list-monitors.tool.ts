import { HOST_LIST_MONITORS_TOOL } from '../../../agents/chat.types';
import type { MonitorBroker } from '../../../agents/services/monitor.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { listMonitorsInstructions } from './list-monitors.instructions';
import {
  listMonitorsResultText,
  readListMonitors,
} from './list-monitors.reader';
import { listMonitorsSchema } from './list-monitors.schema';

/** `list_monitors` — the monitors this conversation has running. */
export class ListMonitorsTool extends BaseMcpTool {
  readonly name = HOST_LIST_MONITORS_TOOL;

  constructor(private readonly monitors: MonitorBroker) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.monitors.canMonitor(runId, nodeId);
  }

  protected instructions(): string {
    return listMonitorsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return listMonitorsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    const input = readListMonitors(args);
    if ('error' in input) {
      return this.invalidArgs(input.error);
    }
    return this.text(
      listMonitorsResultText(await this.monitors.list(runId, nodeId, caller)),
    );
  }
}
