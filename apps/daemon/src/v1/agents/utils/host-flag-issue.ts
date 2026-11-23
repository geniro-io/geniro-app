import { HOST_FLAG_ISSUE_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names `flag_issue`.
 *
 * Auto-approved in every mode: calling it decides nothing the user would weigh.
 * It writes one row the analyses read, refused past a per-conversation cap
 * and on a repeated summary, and its text is masked at the write
 * (`FlagBroker`).
 */
export function isHostFlagIssueCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_FLAG_ISSUE_TOOL);
}
