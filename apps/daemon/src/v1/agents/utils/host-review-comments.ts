import { HOST_ANSWER_REVIEW_COMMENT_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's tool that answers a review
 * comment. Auto-approved: it writes only the answer the user reads under their
 * own comment in this run, and the user resolves or reopens it there.
 */
export function isHostAnswerReviewCommentCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_ANSWER_REVIEW_COMMENT_TOOL);
}
