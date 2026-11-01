import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
  HOST_RECOMMENDATIONS_TOOL,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names the analysis chat's thread reader.
 *
 * The one history reader that is auto-approved, and only because of how it is
 * installed: it exists solely on an analysis chat, reads the ONE thread the
 * user clicked "Analyze" on — or the runs the daemon chose for a team's
 * "Analyze & improve" — each up to the moment they clicked, and every answer
 * leads with the data-not-instructions line and is masked of registered
 * secrets. The general history tools (`search_chats`, `read_chat_context`)
 * read every project and stay behind a card. A large thread takes dozens of
 * pages; a card per page would make the analysis unusable outside `auto`.
 */
export function isHostAnalysisReadCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_ANALYZED_THREAD_TOOL);
}

/**
 * Whether a permission request names the recommendations card or its outcome
 * marks — the render family's reading (`isHostFindingsCall`): the call draws
 * in this app's own transcript and changes nothing outside it.
 */
export function isHostRecommendationsCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return (
    isHostToolCall(serverName, toolName, HOST_RECOMMENDATIONS_TOOL) ||
    isHostToolCall(serverName, toolName, HOST_RECOMMENDATION_MARKS_TOOL)
  );
}
