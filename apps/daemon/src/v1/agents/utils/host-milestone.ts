import { HOST_MILESTONE_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN step tool.
 *
 * Approved for the user in every mode: a step writes one line into this run's
 * own history and nothing else, so a card asking to allow it would guard
 * nothing and fire on every step.
 */
export function isHostMilestoneCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_MILESTONE_TOOL);
}
