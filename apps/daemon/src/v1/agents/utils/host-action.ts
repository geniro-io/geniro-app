import {
  HOST_PUBLISH_ACTION_TOOL,
  HOST_REMOVE_ACTION_TOOL,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names one of geniro's OWN action tools
 * (`publish_action`, `remove_action`).
 *
 * Auto-approved because publishing does nothing by itself: it puts a button in
 * this app's own chat, and whatever the button does happens only when the
 * USER presses it — the press is the gate, so a permission card in front of
 * the publish would ask the user to approve being offered a choice.
 *
 * How the pair is matched belongs to {@link isHostToolCall}.
 */
export function isHostActionCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return (
    isHostToolCall(serverName, toolName, HOST_PUBLISH_ACTION_TOOL) ||
    isHostToolCall(serverName, toolName, HOST_REMOVE_ACTION_TOOL)
  );
}
