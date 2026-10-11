import { HOST_NOTIFY_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/** Whether a tool call is geniro's own `notify_user` on this run's server. */
export function isHostNotifyCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_NOTIFY_TOOL);
}
