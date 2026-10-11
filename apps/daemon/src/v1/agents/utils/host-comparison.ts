import { HOST_COMPARISON_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN comparison tool.
 *
 * Auto-approved like every tool in this family: what the agent would be asking
 * permission for is the act of drawing in this app's own transcript.
 */
export function isHostComparisonCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_COMPARISON_TOOL);
}
