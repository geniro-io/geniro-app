import { HOST_PLAN_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN plan tool.
 *
 * Auto-approved like every tool in this family, and for the patch tool's exact
 * reason: calling it DOES nothing — it puts a plan on screen with Approve and
 * Reject, and the press is the gate. A permission card in front of that one
 * would ask the user to approve the asking.
 */
export function isHostPlanCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_PLAN_TOOL);
}
