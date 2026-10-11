import { HOST_FINDINGS_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN findings tool.
 *
 * Approved for the user on the same reading as the question tool: what the
 * agent is asking to run is the act of DRAWING something in this app's own
 * transcript. There is no side effect behind the press — nothing is written
 * outside the run's own history — so a card asking permission to render a card
 * is a gate with nothing behind it, and it would fire on every report.
 *
 * How the pair is matched belongs to {@link isHostToolCall}.
 */
export function isHostFindingsCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_FINDINGS_TOOL);
}
