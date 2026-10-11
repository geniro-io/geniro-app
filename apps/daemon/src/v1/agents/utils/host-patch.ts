import { HOST_PATCH_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN patch tool.
 *
 * Auto-approved like its two siblings, which reads wrong at first: this is the
 * one host tool that writes to the user's disk, so surely the permission card
 * belongs in front of it? No — that card would guard the wrong door. Calling
 * this tool WRITES NOTHING; it puts a diff on screen with Apply and Reject, and
 * the write is behind that second press. Refusing to auto-approve the call
 * therefore buys no safety and costs the user a meaningless card in front of
 * the meaningful one — observed on a live turn, where answering the first
 * decided nothing at all.
 */
export function isHostPatchCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_PATCH_TOOL);
}
