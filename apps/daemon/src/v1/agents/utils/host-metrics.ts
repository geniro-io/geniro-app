import { HOST_METRICS_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN scorecard tool.
 *
 * Auto-approved like every tool in this family: what the agent would be asking
 * permission for is the act of drawing in this app's own transcript, and a gate
 * there is a press with nothing behind it.
 */
export function isHostMetricsCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_METRICS_TOOL);
}
