import { redactSecrets } from '../../diagnostics/utils/redact';
import type { AgentKind } from '../../runs/runs.types';
import type { ToolCallMetric } from '../adapters/adapter.types';
import type { AgentAdapterRegistry } from '../services/agent-adapter.registry';
import { hostMcpServerName } from './host-question';

/** geniro's own MCP server as a count names it, whatever its per-run name. */
export const GENIRO_MCP_SERVER = 'geniro';

/** What a tool's name may look like to be counted under it; anything else is counted by its kind. */
const TOOL_NAME = /^[\w.:-]{1,64}$/;

/** A server name is counted at most this long. */
const SERVER_NAME_MAX = 64;

/**
 * One tool call as the tool counts name it: the tool and the MCP server it came
 * from. The agent that made the call reads its own name first; a pool member on
 * another CLI spells its calls its own way, so any adapter that reads a server
 * off the name is asked next. A name that is not a tool's (a command or a path a
 * CLI used as the call's title) is counted by the call's kind, never stored.
 */
export function toolMetricOf(
  adapters: AgentAdapterRegistry,
  runId: string,
  agentKind: AgentKind | null,
  name: string,
  toolKind: string | null,
): ToolCallMetric {
  const own =
    agentKind === null
      ? null
      : adapters.for(agentKind).toolCallMetric(name, toolKind);
  const mcp =
    own?.server != null
      ? own
      : [...adapters.all().values()]
          .map((adapter) => adapter.toolCallMetric(name, toolKind))
          .find((metric) => metric.server !== null);
  if (mcp !== undefined && mcp.server !== null && TOOL_NAME.test(mcp.tool)) {
    return {
      tool: mcp.tool,
      server:
        mcp.server === hostMcpServerName(runId)
          ? GENIRO_MCP_SERVER
          : redactSecrets(mcp.server).slice(0, SERVER_NAME_MAX),
    };
  }
  const tool = own?.tool ?? name;
  return {
    tool: TOOL_NAME.test(tool) ? tool : (toolKind ?? 'other'),
    server: null,
  };
}
