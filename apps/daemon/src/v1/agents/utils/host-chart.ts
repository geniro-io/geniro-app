import { HOST_CHART_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN chart tool.
 *
 * Auto-approved on the findings tool's reading: what the agent is asking to run
 * is the act of DRAWING in this app's own transcript. Nothing is written outside
 * the run's own history, so a permission card guarding it is a gate with nothing
 * behind it — and it would fire on every plot.
 *
 * How the pair is matched belongs to {@link isHostToolCall}.
 */
export function isHostChartCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_CHART_TOOL);
}
